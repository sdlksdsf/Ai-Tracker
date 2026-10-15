import React, { useMemo, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import type { ConfirmedItem, DetectedItem, ScanStatusDto } from '@platematch/shared';
import { AI_CONFIDENCE } from '@platematch/shared';
import { categoryIcon, colors, radii, sizes, spacing } from '../../../theme/tokens.js';
import { Screen } from '../../../components/ui/Screen.js';
import { Text } from '../../../components/ui/Text.js';
import { Card } from '../../../components/ui/Card.js';
import { Button } from '../../../components/ui/Button.js';
import { Badge } from '../../../components/ui/Badge.js';
import { ProgressBar } from '../../../components/ui/Progress.js';
import { Chip } from '../../../components/ui/Chip.js';
import { EmptyState, ErrorState } from '../../../components/ui/EmptyState.js';
import { SkeletonList } from '../../../components/ui/Skeleton.js';
import { toast } from '../../../stores/ui.store.js';
import { useConfirmScan, useScanStatus } from '../../../hooks/useApi.js';
import { usePolling } from '../../../hooks/index.js';
import { config } from '../../../lib/config.js';
import { humanize } from '../../../lib/format.js';
import { parseQuantity } from '../../../lib/parse.js';

/**
 * Scan review (Section 6, Screen 4).
 *
 * The user is always the final authority on what goes into the pantry. Every AI
 * detection arrives pre-ticked but editable, low-confidence items are flagged for
 * review rather than silently accepted, and the corrections are sent back with the
 * confirmation so the pipeline can be measured over time.
 */

interface ReviewableItem extends DetectedItem {
  /** Local key — the server has no id for a detection until it is confirmed. */
  key: string;
  accepted: boolean;
  editedName: string;
}

function toReviewable(items: DetectedItem[]): ReviewableItem[] {
  return items.map((item, index) => ({
    ...item,
    key: `${item.name}-${index}`,
    // Pre-accept anything the model is reasonably sure about; ask the user to
    // confirm the rest rather than asking them to re-tick everything.
    accepted: item.confidence >= AI_CONFIDENCE.minAccept,
    editedName: item.name,
  }));
}

export default function ScanResultScreen(): React.ReactElement {
  const { t } = useTranslation('scan');
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const statusQuery = useScanStatus(id ?? null);
  const confirmScan = useConfirmScan();

  const [items, setItems] = useState<ReviewableItem[] | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Poll only while the scan is still working. Once `items` is seeded from a
  // result the polling stops, so reviewing is not racing a refetch.
  const poll = usePolling<ScanStatusDto>({
    enabled: Boolean(id) && items === null,
    intervalMs: config.scanPollIntervalMs,
    timeoutMs: config.scanPollTimeoutMs,
    fetcher: async () => {
      if (!id) return null;
      try {
        return await statusQuery.refetch().then((result) => result.data ?? null);
      } catch {
        return null;
      }
    },
    done: (value) => value.status === 'completed' || value.status === 'failed',
    onTimeout: () => toast('Scanning is taking longer than usual. Pull to refresh in a moment.', 'warning'),
  });

  const scan = useMemo<ScanStatusDto | null>(() => {
    if (items) return poll.value ?? statusQuery.data ?? null;
    return statusQuery.data ?? poll.value ?? null;
  }, [items, poll.value, statusQuery.data]);

  // Seed the review list once, from whichever source resolves first.
  React.useEffect(() => {
    if (items || !scan || scan.status !== 'completed') return;
    setItems(toReviewable(scan.detected_items ?? []));
  }, [items, scan]);

  const isLoading = !scan && (statusQuery.isLoading || poll.isPolling);

  const toggle = (key: string): void =>
    setItems((current) => (current ?? []).map((item) => (item.key === key ? { ...item, accepted: !item.accepted } : item)));

  const rename = (key: string, name: string): void =>
    setItems((current) => (current ?? []).map((item) => (item.key === key ? { ...item, editedName: name } : item)));

  const remove = (key: string): void => setItems((current) => (current ?? []).filter((item) => item.key !== key));

  const accepted = (items ?? []).filter((item) => item.accepted);
  const rejected = (items ?? []).filter((item) => !item.accepted);

  const handleConfirm = async (): Promise<void> => {
    if (!id || !items) return;
    if (!accepted.length) {
      toast('Select at least one item to save', 'warning');
      return;
    }

    setConfirming(true);

    const confirmed: ConfirmedItem[] = accepted.map((item) => {
      const parsed = parseQuantity(item.estimated_quantity ?? null);
      return {
        name: item.editedName.trim() || item.name,
        category: item.category,
        quantity: item.quantity ?? parsed.quantity ?? 1,
        unit: item.unit ?? parsed.unit ?? 'pieces',
        expiry_date: item.expiry_date ?? null,
        location: 'fridge',
        ai_confidence: item.confidence,
      };
    });

    try {
      await confirmScan.mutateAsync({
        scanId: id,
        payload: {
          confirmed,
          removed: rejected.map((item) => item.name),
          // Names the user edited before confirming — this is the accuracy signal.
          corrected: items.filter((item) => item.editedName.trim() !== item.name).map((item) => item.name),
          added: [],
        },
      });
      router.replace('/pantry');
    } finally {
      setConfirming(false);
    }
  };

  // --- Still processing ----------------------------------------------------
  if (isLoading) {
    return (
      <Screen header={{ title: t('title'), back: true, onBack: () => router.back() }} testID="scan-result-screen">
        <Card padding="xl" style={{ gap: spacing.md, alignItems: 'center' }}>
          <Ionicons name="scan" size={40} color={colors.primary} />
          <Text variant="headingSmall">{t('processing')}</Text>
          {/* No scan object exists yet — this is the indeterminate state. */}
          <ProgressBar value={0.25} style={{ alignSelf: 'stretch' }} />
          <Text variant="captionSmall" tone="tertiary">
            {t('processingHint')}
          </Text>
        </Card>
        <SkeletonList count={3} />
      </Screen>
    );
  }

  // --- Failed --------------------------------------------------------------
  if (scan?.status === 'failed') {
    return (
      <Screen header={{ title: t('title'), back: true, onBack: () => router.back() }} testID="scan-result-screen">
        <ErrorState title="Scan failed" message={scan.error ?? undefined} onRetry={() => router.replace('/(tabs)/scan')} />
      </Screen>
    );
  }

  if (!scan) {
    return (
      <Screen header={{ title: t('title'), back: true, onBack: () => router.back() }} testID="scan-result-screen">
        <ErrorState onRetry={() => void statusQuery.refetch()} />
      </Screen>
    );
  }

  const degraded = (scan.detected_items ?? []).length === 0;

  return (
    <Screen
      header={{ title: t('reviewTitle'), subtitle: t('reviewSubtitle'), back: true, onBack: () => router.back() }}
      testID="scan-result-screen"
      footer={
        accepted.length ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="captionSmall" tone="secondary" align="center">
              {t('confirmedCount', { count: accepted.length })}
            </Text>
            <Button label={t('confirmAndSave')} icon="checkmark" onPress={() => void handleConfirm()} loading={confirming} block size="lg" testID="scan-confirm" />
          </View>
        ) : null
      }
    >
      {/* --- Summary -------------------------------------------------------- */}
      <Card padding="lg" style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Ionicons name="checkmark-done-circle" size={sizes.iconMd} color={colors.primary} />
          <Text variant="headingSmall" style={{ flex: 1 }}>
            {t('detectedTitle', { count: scan.detected_items?.length ?? 0 })}
          </Text>
          {scan.processing_time_ms ? (
            <Text variant="captionSmall" tone="tertiary">
              {(scan.processing_time_ms / 1000).toFixed(1)}s
            </Text>
          ) : null}
        </View>

        {scan.ai_model_used ? (
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            <Badge label={scan.ai_model_used} tone="neutral" size="sm" icon="hardware-chip-outline" />
            {scan.overall_fridge_status ? <Badge label={humanize(scan.overall_fridge_status)} tone="accent" size="sm" /> : null}
          </View>
        ) : null}

        {scan.suggestions?.length ? (
          <View style={{ gap: spacing.xs }}>
            {scan.suggestions.slice(0, 3).map((suggestion) => (
              <View key={suggestion} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
                <Ionicons name="bulb-outline" size={sizes.iconXs} color={colors.secondary} style={{ marginTop: 2 }} />
                <Text variant="captionSmall" tone="secondary" style={{ flex: 1 }}>
                  {suggestion}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </Card>

      {/* --- No detections: honest, not faked ------------------------------- */}
      {degraded ? (
        <EmptyState
          icon="eye-off-outline"
          tone="warning"
          title={t('noDetections')}
          description={t('noDetectionsHint')}
          actionLabel="Add items manually"
          onAction={() => router.replace('/pantry?add=1')}
          secondaryLabel={t('retake')}
          onSecondary={() => router.replace('/(tabs)/scan')}
          testID="scan-empty"
        />
      ) : null}

      {/* --- Review list ---------------------------------------------------- */}
      {(items ?? []).length ? (
        <View style={{ gap: spacing.sm }}>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            <Chip label={`All (${items?.length ?? 0})`} selected onPress={() => setItems((current) => (current ?? []).map((item) => ({ ...item, accepted: true })))} size="sm" />
            <Chip label="None" onPress={() => setItems((current) => (current ?? []).map((item) => ({ ...item, accepted: false })))} size="sm" />
            <Chip
              label="High confidence only"
              onPress={() =>
                setItems((current) =>
                  (current ?? []).map((item) => ({ ...item, accepted: item.confidence >= AI_CONFIDENCE.fallbackThreshold })),
                )
              }
              size="sm"
            />
          </View>

          {(items ?? []).map((item) => (
            <DetectedRow
              key={item.key}
              item={item}
              onToggle={() => toggle(item.key)}
              onRename={(name) => rename(item.key, name)}
              onRemove={() => remove(item.key)}
              lowConfidence={item.confidence < AI_CONFIDENCE.minAccept}
            />
          ))}
        </View>
      ) : null}

      <Button
        label={t('addManually')}
        icon="add-circle-outline"
        variant="outline"
        onPress={() => router.push('/pantry?add=1')}
        testID="scan-add-manual"
      />
    </Screen>
  );
}

function DetectedRow({
  item,
  onToggle,
  onRename,
  onRemove,
  lowConfidence,
}: {
  item: ReviewableItem;
  onToggle: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  lowConfidence: boolean;
}): React.ReactElement {
  const { t } = useTranslation('scan');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.editedName);

  const percent = Math.round(item.confidence * 100);
  const quantityLabel = item.estimated_quantity
    ? `${item.estimated_quantity}${item.estimated_unit ? ` ${item.estimated_unit}` : ''}`
    : item.quantity != null
      ? `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`
      : null;

  return (
    <Card
      padding="md"
      style={{
        gap: spacing.sm,
        borderWidth: sizes.borderWidth,
        borderColor: item.accepted ? colors.primary : colors.border,
        backgroundColor: item.accepted ? colors.primarySoft : colors.surface,
        opacity: item.accepted ? 1 : 0.75,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Button
          label=""
          icon={item.accepted ? 'checkbox' : 'square-outline'}
          variant="ghost"
          size="sm"
          onPress={onToggle}
          accessibilityLabel={`${item.accepted ? 'Unselect' : 'Select'} ${item.name}`}
          accessibilityRole="checkbox"
        />

        <Text style={{ fontSize: 20 }}>{categoryIcon(item.category)}</Text>

        <View style={{ flex: 1, gap: 2 }}>
          {editing ? (
            <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                autoFocus
                selectTextOnFocus
                onSubmitEditing={() => {
                  const next = draft.trim();
                  if (next) onRename(next);
                  setEditing(false);
                }}
                returnKeyType="done"
                accessibilityLabel="Ingredient name"
                style={{
                  flex: 1,
                  paddingVertical: 4,
                  paddingHorizontal: spacing.sm,
                  borderRadius: radii.sm,
                  borderWidth: sizes.borderWidth,
                  borderColor: colors.primary,
                  backgroundColor: colors.surface,
                  color: colors.text,
                  fontSize: 15,
                }}
              />
              <Button
                label="Save"
                size="sm"
                onPress={() => {
                  const next = draft.trim();
                  if (next) onRename(next);
                  setEditing(false);
                }}
              />
              <Button label="" icon="close" variant="ghost" size="sm" onPress={() => setEditing(false)} accessibilityLabel="Cancel" />
            </View>
          ) : (
            <Pressable onPress={() => { setDraft(item.editedName); setEditing(true); }} accessibilityRole="button" accessibilityLabel={`Rename ${item.editedName}`}>
              <Text variant="bodyMedium" numberOfLines={1}>
                {item.editedName}
              </Text>
            </Pressable>
          )}

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
            <Text variant="captionSmall" tone="tertiary">
              {humanize(item.category)}
            </Text>
            {quantityLabel ? (
              <Text variant="captionSmall" tone="tertiary">
                · {quantityLabel}
              </Text>
            ) : null}
            {item.expiry_date ? (
              <Text variant="captionSmall" tone="tertiary">
                · exp {item.expiry_date}
              </Text>
            ) : null}
          </View>
        </View>

        <Button label="" icon="trash-outline" variant="ghost" size="sm" onPress={onRemove} accessibilityLabel={`Remove ${item.name}`} />
      </View>

      {/* Confidence */}
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="captionSmall" tone={lowConfidence ? 'warning' : 'tertiary'}>
            {t('confidence', { percent })}
          </Text>
          {lowConfidence ? <Badge label={t('lowConfidence')} tone="warning" size="sm" icon="alert-circle-outline" /> : null}
        </View>
        <ProgressBar
          value={item.confidence}
          height={sizes.progressHeightSm}
          color={lowConfidence ? colors.warning : colors.primary}
        />
      </View>

      {item.detected_by ? (
        <Text variant="captionSmall" tone="tertiary">
          {item.detected_by}
          {item.location_in_image ? ` · ${item.location_in_image}` : ''}
        </Text>
      ) : null}

      <View style={{ borderRadius: radii.sm }} />
    </Card>
  );
}
