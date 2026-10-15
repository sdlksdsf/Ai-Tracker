import React, { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Card } from '../../components/ui/Card.js';
import { Button } from '../../components/ui/Button.js';
import { Badge } from '../../components/ui/Badge.js';
import { SettingsGroup } from './_components.js';
import { api } from '../../lib/api.js';
// `/health` is mounted at the API root, not under `/api/v1` — hence apiUrlFor
// (root) rather than endpointUrl (versioned).
import { apiUrlFor, config } from '../../lib/config.js';
import { toast } from '../../stores/ui.store.js';

/**
 * About, help and the legal links (Section 6, Screen 15).
 *
 * Also the fastest way to diagnose a broken install: the live server health check
 * and the AI provider status are both rendered here, so "why are my scans empty?"
 * is answerable without a support thread.
 */

interface HealthSnapshot {
  status: string;
  version?: string;
  checks?: Record<string, string>;
}

interface AiStatus {
  mode?: string;
  vision?: { mode?: string; chain?: string[] };
  reasoning?: { mode?: string; chain?: string[] };
  nutrition?: Record<string, boolean | string>;
  prices?: Record<string, boolean | string>;
}

const REPO_URL = 'https://github.com/sdlksdsf/Ai-Tracker';

export default function AboutScreen(): React.ReactElement {
  const router = useRouter();
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async (): Promise<void> => {
    setChecking(true);
    try {
      const [healthResult, aiResult] = await Promise.all([
        fetch(apiUrlFor('/health')).then((response) => (response.ok ? (response.json() as Promise<HealthSnapshot>) : null)).catch(() => null),
        api.get<AiStatus>('/ai/status', { anonymous: true, timeoutMs: 8000 }).catch(() => null),
      ]);

      setHealth(healthResult);
      setAi(aiResult);

      if (!healthResult) toast('Cannot reach the server', 'error');
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen header={{ title: 'About', back: true, onBack: () => router.back() }} testID="about-screen">
      {/* --- Brand ---------------------------------------------------------- */}
      <Card padding="xl" style={{ gap: spacing.md, alignItems: 'center' }}>
        <View style={{ width: 72, height: 72, borderRadius: radii.lg, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="nutrition" size={40} color={colors.textInverse} />
        </View>

        <View style={{ gap: 4, alignItems: 'center' }}>
          <Text variant="displaySmall">PlateMatch</Text>
          <Text variant="bodySmall" tone="secondary" align="center">
            Cook what you have. Waste less.
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
            <Badge label={`v${appVersion}`} tone="neutral" size="sm" />
            <Badge label={config.environment} tone={config.isDev ? 'warning' : 'success'} size="sm" />
          </View>
        </View>
      </Card>

      {/* --- Server status --------------------------------------------------- */}
      <SettingsGroup title="Server status">
        <Card padding="lg" style={{ gap: spacing.md }} testID="about-health">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Ionicons
              name={health?.status === 'ok' ? 'checkmark-circle' : health ? 'warning' : 'cloud-offline-outline'}
              size={sizes.iconMd}
              color={health?.status === 'ok' ? colors.success : health ? colors.warning : colors.danger}
            />
            <Text variant="bodyMedium" style={{ flex: 1 }}>
              {checking ? 'Checking…' : health?.status === 'ok' ? 'Connected' : health ? 'Degraded' : 'Unreachable'}
            </Text>
            <Button label="Refresh" icon="refresh" variant="ghost" size="sm" onPress={() => void check()} loading={checking} />
          </View>

          <InfoLine label="API" value={config.apiBaseUrl} />
          {health?.version ? <InfoLine label="Server version" value={health.version} /> : null}

          {health?.checks ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {Object.entries(health.checks).map(([key, value]) => (
                <Badge key={key} label={`${key}: ${value}`} tone={value === 'ok' || value === 'redis' ? 'success' : value === 'down' ? 'danger' : 'neutral'} size="sm" />
              ))}
            </View>
          ) : null}
        </Card>
      </SettingsGroup>

      {/* --- AI status ------------------------------------------------------- */}
      {ai ? (
        <SettingsGroup title="AI providers">
          <Card padding="lg" style={{ gap: spacing.sm }} testID="about-ai">
            <InfoLine label="Mode" value={ai.mode ?? 'unknown'} />

            {ai.vision ? (
              <InfoLine label="Fridge scanning" value={ai.vision.chain?.length ? ai.vision.chain.join(' → ') : ai.vision.mode ?? 'unavailable'} />
            ) : null}

            {ai.reasoning ? (
              <InfoLine label="Recipes & plans" value={ai.reasoning.chain?.length ? ai.reasoning.chain.join(' → ') : ai.reasoning.mode ?? 'unavailable'} />
            ) : null}

            <Text variant="captionSmall" tone="tertiary">
              {ai.vision?.mode === 'mock' || ai.reasoning?.mode === 'mock'
                ? 'This server has no AI keys configured, so PlateMatch is using its built-in deterministic engine. Everything works — recipe generation draws from a 32-recipe corpus and fridge scanning returns an honest "nothing detected" rather than inventing items.'
                : 'Live provider keys are configured. Every call is metered against a per-user daily spend cap.'}
            </Text>
          </Card>
        </SettingsGroup>
      ) : null}

      {/* --- Help ------------------------------------------------------------ */}
      <SettingsGroup title="Help & legal">
        <Card flush>
          <LinkRow icon="help-circle-outline" label="How PlateMatch works" onPress={() => setShowHelp(true)} />
          <LinkRow icon="logo-github" label="Source & documentation" onPress={() => void Linking.openURL(REPO_URL)} />
          <LinkRow icon="document-text-outline" label="Privacy policy" onPress={() => void Linking.openURL(`${REPO_URL}#privacy`)} />
          <LinkRow icon="shield-checkmark-outline" label="Terms of service" onPress={() => void Linking.openURL(`${REPO_URL}#terms`)} last />
        </Card>
      </SettingsGroup>

      {/* --- How it works ---------------------------------------------------- */}
      <Card padding="lg" style={{ gap: spacing.md }}>
        <Text variant="headingSmall">How PlateMatch works</Text>

        {[
          { icon: 'camera-outline', title: 'Scan', body: 'A photo of your fridge is sent to a vision model, which returns named ingredients with quantities and confidence scores. You review every detection before anything is saved.' },
          { icon: 'restaurant-outline', title: 'Cook', body: 'Recipes are ranked by how much of your pantry they use, prioritising anything about to expire. Allergens are re-checked after generation and unsafe recipes are removed whole.' },
          { icon: 'calendar-outline', title: 'Plan', body: 'A weekly plan balances your calorie and macro targets, budget and cooking time, then builds the grocery list from what you are actually missing.' },
          { icon: 'leaf-outline', title: 'Track', body: 'Logging waste turns it into money and CO₂e, which is what makes the next week\'s plan better.' },
        ].map((row) => (
          <View key={row.title} style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
            <View style={{ width: 36, height: 36, borderRadius: radii.sm, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={row.icon as keyof typeof Ionicons.glyphMap} size={sizes.iconSm} color={colors.primary} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="bodyMedium">{row.title}</Text>
              <Text variant="captionSmall" tone="secondary">
                {row.body}
              </Text>
            </View>
          </View>
        ))}
      </Card>

      <Text variant="captionSmall" tone="tertiary" align="center" style={{ paddingBottom: spacing.lg }}>
        Made to cut household food waste. Nutrition figures are estimates and are not a substitute for medical dietary advice.
      </Text>
    </Screen>
  );

  // Hoisted so the LinkRow above can open it without a second state declaration.
  function setShowHelp(_value: boolean): void {
    toast('The "How PlateMatch works" card below explains the full loop', 'info', { durationMs: 5000 });
  }
}

function InfoLine({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'baseline' }}>
      <Text variant="captionSmall" tone="tertiary" style={{ width: 110 }}>
        {label}
      </Text>
      <Text variant="captionSmall" style={{ flex: 1 }} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function LinkRow({
  icon,
  label,
  onPress,
  last = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  last?: boolean;
}): React.ReactElement {
  return (
    <View>
      <Button
        label=""
        variant="ghost"
        onPress={onPress}
        accessibilityLabel={label}
        style={{ height: 56, borderRadius: 0, paddingHorizontal: spacing.lg, justifyContent: 'flex-start' }}
      />
      <View pointerEvents="none" style={{ position: 'absolute', left: spacing.lg, right: spacing.lg, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Ionicons name={icon} size={sizes.iconMd} color={colors.textSecondary} />
        <Text variant="bodyMedium" style={{ flex: 1 }} numberOfLines={1}>
          {label}
        </Text>
        <Ionicons name="open-outline" size={sizes.iconSm} color={colors.textTertiary} />
      </View>
      {last ? null : <View style={{ height: sizes.dividerHeight, backgroundColor: colors.divider, marginLeft: 56 }} />}
    </View>
  );
}
