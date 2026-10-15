import React, { useEffect, useState } from 'react';
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
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen, SectionHeader } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { Chip } from '../../components/ui/Chip.js';
import { Input, QuantityStepper } from '../../components/ui/Input.js';
import { SkeletonList } from '../../components/ui/Skeleton.js';
import { useAuthStore } from '../../stores/auth.store.js';
import { useCurrentUser, useUpdatePreferences, useUpdateProfile } from '../../hooks/useApi.js';
import { api } from '../../lib/api.js';
import { humanize } from '../../lib/format.js';

/**
 * Diet & targets (Section 6, Screen 15).
 *
 * The same fields onboarding collects, editable later — plus the computed calorie
 * and macro targets, shown so the meal-plan verification numbers have an origin
 * the user can inspect and change.
 */

export default function PreferencesScreen(): React.ReactElement {
  const { t } = useTranslation('onboarding');
  const router = useRouter();

  const { data: user, isLoading } = useCurrentUser();
  const setUser = useAuthStore((state) => state.setUser);
  const updateProfile = useUpdateProfile();
  const updatePreferences = useUpdatePreferences();

  const [diet, setDiet] = useState<DietaryPreference>('none');
  const [goal, setGoal] = useState<HealthGoal>('eat_healthy');
  const [activity, setActivity] = useState<ActivityLevel>('moderate');
  const [skill, setSkill] = useState<CookingSkillLevel>('intermediate');
  const [familySize, setFamilySize] = useState(2);
  const [maxTime, setMaxTime] = useState(45);
  const [budget, setBudget] = useState<number | null>(null);
  const [heightCm, setHeightCm] = useState<number | null>(null);
  const [weightKg, setWeightKg] = useState<number | null>(null);
  const [cuisines, setCuisines] = useState<string[]>([]);
  const [allergies, setAllergies] = useState<string[]>([]);
  const [customAllergy, setCustomAllergy] = useState('');
  const [targets, setTargets] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    if (!user) return;
    setDiet(user.dietary_preference);
    setGoal(user.health_goal);
    setActivity(user.activity_level);
    setSkill(user.cooking_skill_level);
    setFamilySize(user.family_size);
    setMaxTime(user.max_cooking_time_min ?? 45);
    setBudget(user.weekly_budget);
    setHeightCm(user.height_cm);
    setWeightKg(user.weight_kg);
    setCuisines(user.preferred_cuisines ?? []);
    setAllergies((user.allergies ?? []).map((allergy) => allergy.allergen));
    setTargets({
      calories: user.daily_calorie_target ?? 0,
      protein: user.daily_protein_target_g ?? 0,
      carbs: user.daily_carbs_target_g ?? 0,
      fat: user.daily_fat_target_g ?? 0,
    });
  }, [user]);

  // Recompute the targets whenever the inputs that drive them change, so the
  // numbers on screen match what the meal planner will actually use.
  useEffect(() => {
    const timer = setTimeout(() => void refreshTargets(), 600);
    return () => clearTimeout(timer);
  }, [goal, activity, heightCm, weightKg]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshTargets = async (): Promise<void> => {
    try {
      const result = await api.get<Record<string, number>>('/users/me/nutrition-targets');
      setTargets(result);
    } catch {
      // Targets are informational here; a failure must not block saving.
    }
  };

  const save = async (): Promise<void> => {
    // Two endpoints, because the fields live on two schemas. Sending all of
    // this to `PATCH /users/me` used to return 200 while Zod silently stripped
    // the diet, the budget and — worst — the allergy list.
    await updateProfile.mutateAsync({
      cooking_skill_level: skill,
      height_cm: heightCm,
      weight_kg: weightKg,
    });

    const updated = await updatePreferences.mutateAsync({
      dietary_preference: diet,
      health_goal: goal,
      activity_level: activity,
      family_size: familySize,
      max_cooking_time_min: maxTime,
      weekly_budget: budget,
      preferred_cuisines: cuisines,
      // Plain names in the UI; the API wants objects and defaults `severity`.
      allergies: allergies.map((allergen) => ({ allergen })),
    });
    setUser(updated);
  };

  const toggle = (list: string[], value: string, setter: (next: string[]) => void): void =>
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

  if (isLoading || !user) {
    return (
      <Screen header={{ title: t('title'), back: true, onBack: () => router.back() }} testID="preferences-screen">
        <SkeletonList count={5} />
      </Screen>
    );
  }

  return (
    <Screen
      header={{ title: t('title'), back: true, onBack: () => router.back() }}
      testID="preferences-screen"
      footer={<Button label={t('common:save', { ns: 'common' })} icon="checkmark" onPress={() => void save()} loading={updateProfile.isPending || updatePreferences.isPending} block size="lg" testID="preferences-save" />}
    >
      {/* --- Targets --------------------------------------------------------- */}
      {targets ? (
        <Card padding="lg" style={{ gap: spacing.md }} testID="preferences-targets">
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="headingSmall">Daily targets</Text>
            <Badge label="Auto-calculated" tone="accent" size="sm" />
          </View>

          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            <TargetStat label="Calories" value={targets.calories ?? 0} unit="kcal" />
            <TargetStat label="Protein" value={targets.protein ?? 0} unit="g" />
            <TargetStat label="Carbs" value={targets.carbs ?? 0} unit="g" />
            <TargetStat label="Fat" value={targets.fat ?? 0} unit="g" />
          </View>

          <Text variant="captionSmall" tone="tertiary">
            Mifflin–St Jeor from your measurements, adjusted for your goal and activity level. Meal plans are verified against the calorie figure within ±10%.
          </Text>
        </Card>
      ) : null}

      {/* --- Diet ------------------------------------------------------------ */}
      <View style={{ gap: spacing.sm }}>
        <SectionHeader title={t('dietaryPreference')} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {DIETARY_PREFERENCES.map((value) => (
            <Chip key={value} label={humanize(value)} selected={diet === value} onPress={() => setDiet(value)} testID={`pref-diet-${value}`} />
          ))}
        </View>
      </View>

      {/* --- Allergies ------------------------------------------------------- */}
      <Card padding="lg" style={{ gap: spacing.md, backgroundColor: colors.dangerSoft }} testID="preferences-allergies">
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
          <Ionicons name="shield-checkmark" size={sizes.iconMd} color={colors.danger} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="bodyMedium" tone="danger">
              {t('allergies')}
            </Text>
            <Text variant="captionSmall" tone="secondary">
              {t('allergiesHint')}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {[...new Set([...COMMON_ALLERGENS, ...allergies])].map((value) => (
            <Chip
              key={value}
              label={humanize(value)}
              selected={allergies.includes(value)}
              onPress={() => toggle(allergies, value, setAllergies)}
              size="sm"
              color={colors.danger}
              onRemove={allergies.includes(value) ? () => toggle(allergies, value, setAllergies) : undefined}
            />
          ))}
        </View>

        <Input
          value={customAllergy}
          onChangeText={setCustomAllergy}
          placeholder={t('addAllergy')}
          icon="add-circle-outline"
          onSubmitEditing={() => {
            const value = customAllergy.trim().toLowerCase();
            if (value && !allergies.includes(value)) setAllergies([...allergies, value]);
            setCustomAllergy('');
          }}
          returnKeyType="done"
        />
      </Card>

      {/* --- Goals ----------------------------------------------------------- */}
      <View style={{ gap: spacing.sm }}>
        <SectionHeader title={t('healthGoal')} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {HEALTH_GOALS.map((value) => (
            <Chip key={value} label={humanize(value)} selected={goal === value} onPress={() => setGoal(value)} />
          ))}
        </View>
      </View>

      <View style={{ gap: spacing.sm }}>
        <SectionHeader title={t('activityLevel')} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {ACTIVITY_LEVELS.map((value) => (
            <Chip key={value} label={humanize(value)} selected={activity === value} onPress={() => setActivity(value)} size="sm" />
          ))}
        </View>
      </View>

      {/* --- Measurements ---------------------------------------------------- */}
      <Card padding="lg" style={{ gap: spacing.md }}>
        <Text variant="headingSmall">Measurements</Text>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            Height
          </Text>
          <QuantityStepper value={heightCm ?? 170} onChange={(value) => setHeightCm(value)} min={120} max={230} step={1} suffix="cm" />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            Weight
          </Text>
          <QuantityStepper value={weightKg ?? 70} onChange={(value) => setWeightKg(value)} min={35} max={250} step={1} suffix="kg" />
        </View>
      </Card>

      {/* --- Kitchen --------------------------------------------------------- */}
      <Card padding="lg" style={{ gap: spacing.md }}>
        <Text variant="headingSmall">Cooking</Text>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            {t('familySize')}
          </Text>
          <QuantityStepper value={familySize} onChange={setFamilySize} min={1} max={12} step={1} suffix={familySize === 1 ? 'person' : 'people'} />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            {t('maxTime')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {[15, 30, 45, 60, 90].map((minutes) => (
              <Chip key={minutes} label={`${minutes} min`} selected={maxTime === minutes} onPress={() => setMaxTime(minutes)} size="sm" />
            ))}
          </View>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            {t('cookingSkill')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {COOKING_SKILL_LEVELS.map((value) => (
              <Chip key={value} label={humanize(value)} selected={skill === value} onPress={() => setSkill(value)} size="sm" />
            ))}
          </View>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text variant="caption" tone="secondary">
            {t('weeklyBudget')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            {[40, 60, 80, 120, 200].map((amount) => (
              <Chip key={amount} label={`$${amount}`} selected={budget === amount} onPress={() => setBudget(amount)} size="sm" />
            ))}
          </View>
        </View>
      </Card>

      {/* --- Cuisines -------------------------------------------------------- */}
      <View style={{ gap: spacing.sm }}>
        <SectionHeader title={t('cuisines')} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {CUISINES.map((value) => (
            <Chip key={value} label={humanize(value)} selected={cuisines.includes(value)} onPress={() => toggle(cuisines, value, setCuisines)} size="sm" />
          ))}
        </View>
      </View>

      <View style={{ borderRadius: radii.sm }} />
    </Screen>
  );
}

function TargetStat({ label, value, unit }: { label: string; value: number; unit: string }): React.ReactElement {
  return (
    <View style={{ flex: 1, gap: 1 }}>
      <Text variant="statSmall">{Math.round(value)}</Text>
      <Text variant="captionSmall" tone="tertiary" numberOfLines={1}>
        {label} ({unit})
      </Text>
    </View>
  );
}
