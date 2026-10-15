import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button, IconButton } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { Chip } from '../../components/ui/Chip.js';
import { ProgressBar } from '../../components/ui/Progress.js';
import { Sheet } from '../../components/ui/Sheet.js';
import { ErrorState } from '../../components/ui/EmptyState.js';
import { SkeletonList } from '../../components/ui/Skeleton.js';
import { toast } from '../../stores/ui.store.js';
import { useUiStore } from '../../stores/ui.store.js';
import { useCookRecipe, useRecipe } from '../../hooks/useApi.js';
import { formatDuration } from '../../lib/format.js';

/**
 * Cooking mode (Section 6, Screen 8).
 *
 * Built for wet hands and a screen propped against a jar: one step at a time in
 * large type, the screen kept awake, optional spoken steps, and a finish action
 * that consumes the pantry ingredients this recipe used.
 *
 * Voice guidance is a Premium feature (`cookingModeVoice` in PLAN_LIMITS), so it
 * is hidden rather than disabled for free users — a control that cannot work is
 * worse than no control.
 */

export default function CookingModeScreen(): React.ReactElement {
  const { t } = useTranslation('recipes');
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: recipe, isLoading, isError, error, refetch } = useRecipe(id ?? null);
  const cookRecipe = useCookRecipe();
  const voiceEnabled = useUiStore((state) => state.voiceEnabled);
  const setVoiceEnabled = useUiStore((state) => state.setVoice);
  const hapticsEnabled = useUiStore((state) => state.hapticsEnabled);

  // Screen must not sleep mid-recipe.
  useKeepAwake();

  const [stepIndex, setStepIndex] = useState(0);
  const [checkedIngredients, setCheckedIngredients] = useState<Set<string>>(new Set());
  const [showFinish, setShowFinish] = useState(false);
  const [consumePantry, setConsumePantry] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerTarget, setTimerTarget] = useState<number | null>(null);

  const steps = useMemo(() => recipe?.steps ?? [], [recipe?.steps]);
  const ingredients = useMemo(() => recipe?.ingredients ?? [], [recipe?.ingredients]);
  const currentStep = steps[stepIndex] ?? null;
  const isLastStep = stepIndex >= steps.length - 1;

  const canUseVoice = voiceEnabled;

  // --- Step timer ----------------------------------------------------------
  useEffect(() => {
    if (!timerRunning) return;

    const interval = setInterval(() => {
      setElapsedSeconds((current) => {
        if (timerTarget !== null && current + 1 >= timerTarget) {
          setTimerRunning(false);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
          Speech.stop();
          Speech.speak('Timer finished');
          toast('Step timer finished', 'success');
          return 0;
        }
        return current + 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [timerRunning, timerTarget]);

  // --- Voice guidance ------------------------------------------------------
  const speakStep = useCallback(
    (index: number) => {
      if (!canUseVoice) return;
      const step = steps[index];
      if (!step) return;

      Speech.stop();
      Speech.speak(`Step ${step.step_number}. ${step.instruction}${step.tip ? `. Tip: ${step.tip}` : ''}`, {
        rate: 0.95,
        pitch: 1,
        language: 'en-US',
      });
    },
    [canUseVoice, steps],
  );

  // Speak the step whenever it changes and voice is on.
  useEffect(() => {
    speakStep(stepIndex);
  }, [stepIndex, speakStep]);

  // Stop talking when the screen goes away, otherwise narration continues over
  // the next screen.
  // A cleanup function must return void, and `Speech.stop()` is async.
  useEffect(() => () => { void Speech.stop(); }, []);

  const goToStep = (index: number): void => {
    const clamped = Math.max(0, Math.min(steps.length - 1, index));
    setStepIndex(clamped);
    setElapsedSeconds(0);
    setTimerRunning(false);
    setTimerTarget(steps[clamped]?.duration_min ? steps[clamped]!.duration_min! * 60 : null);
    if (hapticsEnabled) void Haptics.selectionAsync().catch(() => undefined);
  };

  const toggleIngredient = (key: string): void => {
    setCheckedIngredients((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  };

  const handleFinish = async (): Promise<void> => {
    Speech.stop();
    setShowFinish(false);

    try {
      const result = await cookRecipe.mutateAsync({
        id: recipe!.id,
        input: {
          servings: recipe!.servings,
          // Anything unticked was not used, so it should not be consumed.
          skip_ingredients: ingredients
            .filter((ingredient) => !checkedIngredients.has(ingredientKey(ingredient)))
            .map((ingredient) => ingredient.ingredient_name),
          consume_pantry: consumePantry,
        },
      });

      toast(result.consumed > 0 ? `Nice work — ${result.consumed} pantry items used up` : 'Marked as cooked', 'success');
      router.back();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  if (isLoading) {
    return (
      <Screen header={{ title: t('cookingMode'), back: true, onBack: () => { Speech.stop(); router.back(); } }} testID="cooking-screen">
        <SkeletonList count={3} />
      </Screen>
    );
  }

  if (isError || !recipe || !currentStep) {
    return (
      <Screen header={{ title: t('cookingMode'), back: true, onBack: () => router.back() }} testID="cooking-screen">
        <ErrorState message={(error as Error)?.message ?? 'This recipe has no steps.'} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  const progress = steps.length > 0 ? (stepIndex + 1) / steps.length : 0;

  return (
    <Screen
      padding={false}
      testID="cooking-screen"
      header={undefined}
      contentStyle={{ paddingBottom: 0 }}
      footer={
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <Button
            label=""
            icon="chevron-back"
            variant="outline"
            disabled={stepIndex === 0}
            onPress={() => goToStep(stepIndex - 1)}
            accessibilityLabel={t('previousStep')}
            style={{ width: 60 }}
          />
          {isLastStep ? (
            <Button label={t('finishCooking')} icon="checkmark-done" onPress={() => setShowFinish(true)} style={{ flex: 1 }} size="lg" testID="cooking-finish" />
          ) : (
            <Button label={t('nextStep')} icon="chevron-forward" iconRight={undefined} onPress={() => goToStep(stepIndex + 1)} style={{ flex: 1 }} size="lg" testID="cooking-next" />
          )}
        </View>
      }
    >
      {/* --- Header --------------------------------------------------------- */}
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.xxl, gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <IconButton icon="chevron-back" onPress={() => { Speech.stop(); router.back(); }} accessibilityLabel="Exit cooking mode" />
          <View style={{ flex: 1 }}>
            <Text variant="headingSmall" numberOfLines={1}>
              {recipe.title}
            </Text>
            <Text variant="captionSmall" tone="tertiary">
              {t('stepOf', { current: stepIndex + 1, total: steps.length })}
            </Text>
          </View>

          <IconButton
            icon={canUseVoice ? 'volume-high-outline' : 'volume-mute-outline'}
            tone={canUseVoice ? colors.primary : colors.textTertiary}
            onPress={() => {
              if (canUseVoice) Speech.stop();
              setVoiceEnabled(!canUseVoice);
            }}
            accessibilityLabel={canUseVoice ? t('voiceOff') : t('voiceOn')}
            testID="cooking-voice"
          />
        </View>

        <ProgressBar value={progress} testID="cooking-progress" />
      </View>

      {/* --- Ingredients checklist ------------------------------------------ */}
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="overline" tone="tertiary">
            ON THE COUNTER
          </Text>
          <Text variant="captionSmall" tone="tertiary">
            {checkedIngredients.size}/{ingredients.length}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
          {ingredients.map((ingredient) => {
            const key = ingredientKey(ingredient);
            const checked = checkedIngredients.has(key);
            return (
              <Chip
                key={key}
                label={ingredient.ingredient_name}
                selected={checked}
                onPress={() => toggleIngredient(key)}
                size="sm"
                color={checked ? colors.success : undefined}
                icon={ingredient.is_in_pantry ? 'checkmark-circle-outline' : undefined}
              />
            );
          })}
        </View>
      </View>

      {/* --- Current step ---------------------------------------------------- */}
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg }}>
        <Card padding="xl" style={{ gap: spacing.lg }} testID="cooking-step">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: radii.pill,
                backgroundColor: colors.primary,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text variant="headingMedium" style={{ color: colors.textInverse }}>
                {currentStep.step_number}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="caption" tone="tertiary">
                Step {currentStep.step_number} of {steps.length}
              </Text>
              {currentStep.duration_min ? (
                <Text variant="captionSmall" tone="secondary">
                  About {formatDuration(currentStep.duration_min)}
                </Text>
              ) : null}
            </View>
          </View>

          {/* Large type — this is read from arm's length with wet hands. */}
          <Text variant="displaySmall" style={{ fontSize: 26, lineHeight: 36 }}>
            {currentStep.instruction}
          </Text>

          {currentStep.tip ? (
            <View style={{ flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderRadius: radii.sm, backgroundColor: colors.secondarySoft }}>
              <Ionicons name="bulb-outline" size={sizes.iconSm} color={colors.secondaryDark} />
              <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
                {currentStep.tip}
              </Text>
            </View>
          ) : null}

          {/* Step timer */}
          {currentStep.duration_min ? (
            <View style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="stat" testID="cooking-timer">
                  {formatClock(timerTarget !== null ? Math.max(0, timerTarget - elapsedSeconds) : currentStep.duration_min * 60)}
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <Button
                    label={timerRunning ? 'Pause' : 'Start timer'}
                    icon={timerRunning ? 'pause' : 'play'}
                    size="sm"
                    variant={timerRunning ? 'outline' : 'secondary'}
                    onPress={() => {
                      setTimerRunning((running) => !running);
                      if (!timerRunning && timerTarget === null) setTimerTarget(currentStep.duration_min! * 60);
                    }}
                    testID="cooking-timer-toggle"
                  />
                  <Button
                    label=""
                    icon="refresh"
                    size="sm"
                    variant="ghost"
                    onPress={() => {
                      setElapsedSeconds(0);
                      setTimerRunning(false);
                    }}
                    accessibilityLabel="Reset timer"
                  />
                </View>
              </View>
              {timerRunning && timerTarget ? (
                <ProgressBar value={elapsedSeconds / timerTarget} color={colors.secondary} />
              ) : null}
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button label="" icon="volume-high-outline" variant="ghost" onPress={() => speakStep(stepIndex)} accessibilityLabel="Repeat this step aloud" />
            <Badge label={t('cookingMode')} tone="primary" />
          </View>
        </Card>

        <Text variant="captionSmall" tone="tertiary" align="center">
          {t('cookingModeHint')}
        </Text>

        {/* Step dots for quick jumping */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
          {steps.map((step, index) => (
            <Button
              key={step.id ?? index}
              label=""
              onPress={() => goToStep(index)}
              accessibilityLabel={`Go to step ${index + 1}`}
              style={{
                width: 34,
                height: 34,
                minWidth: 34,
                paddingHorizontal: 0,
                borderRadius: radii.pill,
                backgroundColor: index === stepIndex ? colors.primary : index < stepIndex ? colors.primarySoft : colors.divider,
              }}
            />
          ))}
        </View>
      </View>

      {/* --- Finish ---------------------------------------------------------- */}
      <Sheet
        visible={showFinish}
        onClose={() => setShowFinish(false)}
        title={t('finishCooking')}
        subtitle={recipe.title}
        scrollable={false}
        testID="cooking-finish-sheet"
      >
        <View style={{ gap: spacing.lg }}>
          <Chip
            label={t('consumePantry')}
            icon={consumePantry ? 'checkbox' : 'square-outline'}
            selected={consumePantry}
            onPress={() => setConsumePantry((value) => !value)}
          />
          <Text variant="captionSmall" tone="tertiary">
            {checkedIngredients.size} of {ingredients.length} ingredients were on the counter. Anything unticked is left in your pantry.
          </Text>

          <Button label={t('finishCooking')} icon="checkmark-done" onPress={() => void handleFinish()} loading={cookRecipe.isPending} block size="lg" />
          <Button label={t('common:cancel', { ns: 'common' })} variant="ghost" onPress={() => setShowFinish(false)} block />
        </View>
      </Sheet>
    </Screen>
  );
}

/** Stable key for an ingredient checkbox. */
function ingredientKey(ingredient: { id?: string; ingredient_name: string }): string {
  return ingredient.id ?? ingredient.ingredient_name;
}

/** Seconds → "m:ss". */
function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
