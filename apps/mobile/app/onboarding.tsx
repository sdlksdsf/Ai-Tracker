import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import {
  ACTIVITY_LEVELS,
  COMMON_ALLERGENS,
  COOKING_SKILL_LEVELS,
  type ActivityLevel,
  type CookingSkillLevel,
  CUISINES,
  DIETARY_PREFERENCES,
  type DietaryPreference,
  HEALTH_GOALS,
  type HealthGoal,
} from '@platematch/shared';
import { colors, sizes, spacing } from '../theme/tokens.js';
import { Screen } from '../components/ui/Screen.js';
import { Text } from '../components/ui/Text.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { Chip } from '../components/ui/Chip.js';
import { Input, QuantityStepper } from '../components/ui/Input.js';
import { ProgressBar } from '../components/ui/Progress.js';
import { Sheet, OptionSheet, type SheetOption } from '../components/ui/Sheet.js';
import { toast } from '../stores/ui.store.js';
import { useAuthStore } from '../stores/auth.store.js';
import { useCompleteOnboarding } from '../hooks/useApi.js';
import { kv, StorageKeys } from '../lib/kv.js';
import { humanize } from '../lib/format.js';

/**
 * Onboarding.
 *
 * Four short steps rather than one long form: dietary preference and allergies
 * (safety-critical), goals and activity (drives the calorie target), household and
 * cooking constraints (drives recipe selection), and budget/cuisines (drives meal
 * planning). Each step is skippable — a user who bails still gets a working app,
 * because every field has a server-side default.
 *
 * The allergy step is the one that must not be silently skipped, so it states what
 * the guarantee is rather than just asking for a list.
 */

const STEPS = ['diet', 'goals', 'kitchen', 'tastes'] as const;
type Step = (typeof STEPS)[number];

export default function OnboardingScreen(): React.ReactElement {
  const { t } = useTranslation('onboarding');
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const completeOnboarding = useCompleteOnboarding();

  const [stepIndex, setStepIndex] = useState(0);
  const step: Step = STEPS[stepIndex] ?? 'diet';

  // --- Diet ---------------------------------------------------------------
  const [diet, setDiet] = useState<DietaryPreference>(user?.dietary_preference ?? 'none');
  const [allergies, setAllergies] = useState<string[]>(() => (user?.allergies ?? []).map((allergy) => allergy.allergen));
  const [customAllergy, setCustomAllergy] = useState('');
  const [showAllergySheet, setShowAllergySheet] = useState(false);

  // --- Goals --------------------------------------------------------------
  const [goal, setGoal] = useState<HealthGoal>(user?.health_goal ?? 'eat_healthy');
  const [activity, setActivity] = useState<ActivityLevel>(user?.activity_level ?? 'moderate');
  const [age, setAge] = useState<number>(30);
  const [heightCm, setHeightCm] = useState<number>(user?.height_cm ?? 170);
  const [weightKg, setWeightKg] = useState<number>(user?.weight_kg ?? 70);
  const [showGoalSheet, setGoalSheet] = useState(false);
  const [showActivitySheet, setActivitySheet] = useState(false);

  // --- Kitchen ------------------------------------------------------------
  const [familySize, setFamilySize] = useState<number>(user?.family_size ?? 2);
  const [skill, setSkill] = useState<CookingSkillLevel>(user?.cooking_skill_level ?? 'intermediate');
  const [maxTime, setMaxTime] = useState<number>(user?.max_cooking_time_min ?? 45);

  // --- Tastes -------------------------------------------------------------
  const [budget, setBudget] = useState<number>(user?.weekly_budget ?? 80);
  const [cuisines, setCuisines] = useState<string[]>(user?.preferred_cuisines ?? []);

  const goalOptions: Array<SheetOption<HealthGoal>> = useMemo(
    () => HEALTH_GOALS.map((value) => ({ value, label: humanize(value), description: goalDescription(value) })),
    [],
  );
  const activityOptions: Array<SheetOption<ActivityLevel>> = useMemo(
    () => ACTIVITY_LEVELS.map((value) => ({ value, label: humanize(value), description: activityDescription(value) })),
    [],
  );

  const toggleAllergy = (value: string): void =>
    setAllergies((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));

  const toggleCuisine = (value: string): void =>
    setCuisines((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]));

  const next = (): void => {
    if (stepIndex < STEPS.length - 1) setStepIndex(stepIndex + 1);
    else void finish();
  };

  const skip = (): void => {
    kv.setBoolean(StorageKeys.onboardingSeen, true);
    toast('You can finish setting up any time from Profile → Preferences', 'info');
    router.replace('/(tabs)');
  };

  const finish = async (): Promise<void> => {
    try {
      // The onboarding endpoint accepts profile *and* preference fields in one
      // call. `PATCH /users/me` would have stripped everything but the profile.
      const updated = await completeOnboarding.mutateAsync({
        dietary_preference: diet,
        health_goal: goal,
        activity_level: activity,
        height_cm: heightCm,
        weight_kg: weightKg,
        family_size: familySize,
        cooking_skill_level: skill,
        max_cooking_time_min: maxTime,
        weekly_budget: budget,
        preferred_cuisines: cuisines,
        onboarding_completed: true,
        // The UI tracks allergens as plain names; the API wants objects and
        // defaults `severity` to "moderate" server-side.
        allergies: allergies.map((allergen) => ({ allergen })),
      });

      setUser(updated);
      kv.setBoolean(StorageKeys.onboardingSeen, true);
      router.replace('/(tabs)');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const progress = (stepIndex + 1) / STEPS.length;

  return (
    <Screen
      header={{ title: t('title'), subtitle: t('stepOf', { current: stepIndex + 1, total: STEPS.length }) }}
      keyboardAvoiding
      testID="onboarding-screen"
      footer={
        <View style={{ gap: spacing.sm }}>
          <ProgressBar value={progress} height={sizes.progressHeightSm} />
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            {stepIndex > 0 ? (
              <Button label={t('common:back', { ns: 'common' })} icon="chevron-back" variant="ghost" onPress={() => setStepIndex(stepIndex - 1)} style={{ flex: 1 }} />
            ) : (
              <Button label={t('skip')} variant="ghost" onPress={skip} style={{ flex: 1 }} testID="onboarding-skip" />
            )}
            <Button
              label={stepIndex === STEPS.length - 1 ? t('finish') : t('common:next', { ns: 'common' })}
              icon={stepIndex === STEPS.length - 1 ? 'checkmark' : 'chevron-forward'}
              onPress={next}
              loading={completeOnboarding.isPending}
              style={{ flex: 2 }}
              testID="onboarding-next"
            />
          </View>
        </View>
      }
    >
      {/* --- Step 1: diet + allergies --------------------------------------- */}
      {step === 'diet' ? (
        <View style={{ gap: spacing.lg }}>
          <View style={{ gap: spacing.sm }}>
            <Text variant="headingSmall">{t('dietaryPreference')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {DIETARY_PREFERENCES.map((value) => (
                <Chip key={value} label={humanize(value)} selected={diet === value} onPress={() => setDiet(value)} testID={`onboarding-diet-${value}`} />
              ))}
            </View>
          </View>

          <Card padding="lg" style={{ gap: spacing.md, backgroundColor: colors.dangerSoft }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
              <Ionicons name="shield-checkmark" size={sizes.iconMd} color={colors.danger} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodyMedium" tone="danger">
                  {t('allergies')}
                </Text>
                <Text variant="captionSmall" tone="secondary">
                  {t('allergiesHint')} Every generated recipe is re-checked after the model returns it, and anything containing one of these is removed entirely — never quietly edited.
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {COMMON_ALLERGENS.map((value) => (
                <Chip
                  key={value}
                  label={humanize(value)}
                  selected={allergies.includes(value)}
                  onPress={() => toggleAllergy(value)}
                  size="sm"
                  color={colors.danger}
                  testID={`onboarding-allergy-${value}`}
                />
              ))}
            </View>

            {allergies.filter((value) => !COMMON_ALLERGENS.includes(value as never)).length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {allergies
                  .filter((value) => !COMMON_ALLERGENS.includes(value as never))
                  .map((value) => (
                    <Chip key={value} label={humanize(value)} selected size="sm" color={colors.danger} onRemove={() => toggleAllergy(value)} />
                  ))}
              </View>
            ) : null}

            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Input value={customAllergy} onChangeText={setCustomAllergy} placeholder="Something else?" onSubmitEditing={() => {
                  if (customAllergy.trim()) {
                    toggleAllergy(customAllergy.trim().toLowerCase());
                    setCustomAllergy('');
                  }
                }} returnKeyType="done" testID="onboarding-allergy-custom" />
              </View>
              <Button
                label={t('addAllergy')}
                icon="add"
                variant="outline"
                onPress={() => {
                  if (customAllergy.trim()) {
                    toggleAllergy(customAllergy.trim().toLowerCase());
                    setCustomAllergy('');
                  } else {
                    setShowAllergySheet(true);
                  }
                }}
              />
            </View>
          </Card>
        </View>
      ) : null}

      {/* --- Step 2: goals --------------------------------------------------- */}
      {step === 'goals' ? (
        <View style={{ gap: spacing.lg }}>
          <Card padding="lg" onPress={() => setGoalSheet(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Ionicons name="flag-outline" size={sizes.iconMd} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text variant="captionSmall" tone="tertiary">
                {t('healthGoal')}
              </Text>
              <Text variant="bodyMedium">{humanize(goal)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.textTertiary} />
          </Card>

          <Card padding="lg" onPress={() => setActivitySheet(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Ionicons name="walk-outline" size={sizes.iconMd} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text variant="captionSmall" tone="tertiary">
                {t('activityLevel')}
              </Text>
              <Text variant="bodyMedium">{humanize(activity)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.textTertiary} />
          </Card>

          <Card padding="lg" style={{ gap: spacing.md }}>
            <Text variant="headingSmall">Your measurements</Text>
            <Text variant="captionSmall" tone="tertiary">
              Used with the Mifflin–St Jeor equation to set your daily calorie and macro targets. Nothing is shared and you can change it later.
            </Text>

            <View style={{ gap: spacing.sm }}>
              <Text variant="caption" tone="secondary">
                Age
              </Text>
              <QuantityStepper value={age} onChange={setAge} min={13} max={100} step={1} suffix="years" testID="onboarding-age" />
            </View>

            <View style={{ gap: spacing.sm }}>
              <Text variant="caption" tone="secondary">
                Height
              </Text>
              <QuantityStepper value={heightCm} onChange={setHeightCm} min={120} max={230} step={1} suffix="cm" testID="onboarding-height" />
            </View>

            <View style={{ gap: spacing.sm }}>
              <Text variant="caption" tone="secondary">
                Weight
              </Text>
              <QuantityStepper value={weightKg} onChange={setWeightKg} min={35} max={250} step={1} suffix="kg" testID="onboarding-weight" />
            </View>
          </Card>
        </View>
      ) : null}

      {/* --- Step 3: kitchen ------------------------------------------------- */}
      {step === 'kitchen' ? (
        <View style={{ gap: spacing.lg }}>
          <Card padding="lg" style={{ gap: spacing.md }}>
            <Text variant="headingSmall">{t('familySize')}</Text>
            <Text variant="captionSmall" tone="tertiary">
              Recipes and meal plans are scaled to this many servings, and grocery quantities follow.
            </Text>
            <QuantityStepper value={familySize} onChange={setFamilySize} min={1} max={12} step={1} suffix={familySize === 1 ? 'person' : 'people'} testID="onboarding-family" />
          </Card>

          <View style={{ gap: spacing.sm }}>
            <Text variant="headingSmall">{t('cookingSkill')}</Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              {COOKING_SKILL_LEVELS.map((value) => (
                <Chip key={value} label={humanize(value)} selected={skill === value} onPress={() => setSkill(value)} testID={`onboarding-skill-${value}`} />
              ))}
            </View>
          </View>

          <Card padding="lg" style={{ gap: spacing.md }}>
            <Text variant="headingSmall">{t('maxTime')}</Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              {[15, 30, 45, 60, 90].map((minutes) => (
                <Chip key={minutes} label={`${minutes} min`} selected={maxTime === minutes} onPress={() => setMaxTime(minutes)} testID={`onboarding-time-${minutes}`} />
              ))}
            </View>
            <Text variant="captionSmall" tone="tertiary">
              Weeknight suggestions stay under this; longer recipes still appear when you search for them.
            </Text>
          </Card>
        </View>
      ) : null}

      {/* --- Step 4: tastes -------------------------------------------------- */}
      {step === 'tastes' ? (
        <View style={{ gap: spacing.lg }}>
          <Card padding="lg" style={{ gap: spacing.md }}>
            <Text variant="headingSmall">{t('weeklyBudget')}</Text>
            <Text variant="captionSmall" tone="tertiary">
              Meal plans aim to keep the weekly grocery list near this. Leave it low and the planner leans on pantry staples.
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              {[40, 60, 80, 120, 200].map((amount) => (
                <Chip key={amount} label={`$${amount}`} selected={budget === amount} onPress={() => setBudget(amount)} testID={`onboarding-budget-${amount}`} />
              ))}
            </View>
          </Card>

          <View style={{ gap: spacing.sm }}>
            <Text variant="headingSmall">{t('cuisines')}</Text>
            <Text variant="captionSmall" tone="tertiary">
              Pick as many as you like — these bias generation, they do not restrict search.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {CUISINES.map((value) => (
                <Chip key={value} label={humanize(value)} selected={cuisines.includes(value)} onPress={() => toggleCuisine(value)} size="sm" testID={`onboarding-cuisine-${value}`} />
              ))}
            </View>
          </View>

          <Card padding="lg" style={{ gap: spacing.sm, backgroundColor: colors.primarySoft }}>
            <Text variant="headingSmall" tone="primary">
              You are all set
            </Text>
            <Text variant="bodySmall" tone="secondary">
              Next: scan your fridge, or open the pantry and add a few things by hand. Either way the first recipe suggestions will be based on what you actually have.
            </Text>
          </Card>
        </View>
      ) : null}

      <OptionSheet visible={showGoalSheet} onClose={() => setGoalSheet(false)} onSelect={setGoal} options={goalOptions} selected={goal} title={t('healthGoal')} />
      <OptionSheet visible={showActivitySheet} onClose={() => setActivitySheet(false)} onSelect={setActivity} options={activityOptions} selected={activity} title={t('activityLevel')} />
      <Sheet visible={showAllergySheet} onClose={() => setShowAllergySheet(false)} title={t('allergies')} testID="onboarding-allergy-sheet">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {COMMON_ALLERGENS.map((value) => (
            <Chip key={value} label={humanize(value)} selected={allergies.includes(value)} onPress={() => toggleAllergy(value)} size="sm" color={colors.danger} />
          ))}
        </View>
        <Button label={t('common:done', { ns: 'common' })} onPress={() => setShowAllergySheet(false)} block />
      </Sheet>
    </Screen>
  );
}

function goalDescription(goal: string): string {
  switch (goal) {
    case 'lose_weight':
      return 'A moderate calorie deficit with protein kept high';
    case 'gain_muscle':
      return 'A calorie surplus with extra protein';
    case 'maintain':
      return 'Hold your current weight';
    case 'manage_diabetes':
      return 'Lower carbohydrate, steady meal timing';
    default:
      return 'Balanced meals, less waste';
  }
}

function activityDescription(level: string): string {
  switch (level) {
    case 'sedentary':
      return 'Desk work, little planned exercise';
    case 'light':
      return 'Light exercise 1–3 days a week';
    case 'moderate':
      return 'Moderate exercise 3–5 days a week';
    case 'active':
      return 'Hard exercise 6–7 days a week';
    case 'very_active':
      return 'Physical job plus daily training';
    default:
      return '';
  }
}
