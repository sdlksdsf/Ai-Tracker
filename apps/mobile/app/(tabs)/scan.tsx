import React, { useCallback, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, sizes, spacing, zIndex } from '../../theme/tokens.js';
import { Screen } from '../../components/ui/Screen.js';
import { Text } from '../../components/ui/Text.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { toast } from '../../stores/ui.store.js';
import { useUiStore } from '../../stores/ui.store.js';
import { useCreateScan } from '../../hooks/useApi.js';
import { config } from '../../lib/config.js';
import { createLogger } from '../../lib/logger.js';

/**
 * Fridge scanner (Section 6, Screen 3).
 *
 * Three states: ask for permission → viewfinder → uploading. The upload uses
 * `?wait=true` so the result arrives inline and the review screen opens directly;
 * if that times out the scan id is still valid and the result screen polls it.
 */

const log = createLogger('ScanScreen');

type ScanPhase = 'permission' | 'viewfinder' | 'uploading';

export default function ScanScreen(): React.ReactElement {
  const { t } = useTranslation('scan');
  const router = useRouter();
  const busy = useUiStore((state) => state.setBusy);

  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<ScanPhase>('viewfinder');
  const cameraRef = React.useRef<CameraView | null>(null);

  const createScan = useCreateScan();

  // The permission gate is the first thing a new user sees, so resolve it before
  // rendering the viewfinder rather than showing a black rectangle.
  React.useEffect(() => {
    if (!permission) return;
    setPhase(permission.granted ? 'viewfinder' : 'permission');
  }, [permission]);

  const upload = useCallback(
    async (uri: string) => {
      setPhase('uploading');
      busy(true, t('processing'));

      try {
        const result = await createScan.mutateAsync({ uri, wait: true });
        log.info('Scan accepted', { scanId: result.scan_id, status: result.status });
        router.push(`/scan/result/${result.scan_id}`);
      } catch (error) {
        log.error('Scan upload failed', error);
        toast((error as Error).message, 'error');
        setPhase('viewfinder');
      } finally {
        busy(false);
      }
    },
    [busy, createScan, router, t],
  );

  const handleCapture = useCallback(async () => {
    const camera = cameraRef.current;
    if (!camera) {
      toast('The camera is not ready yet', 'warning');
      return;
    }

    useUiStore.getState().tap();

    try {
      const photo = await camera.takePictureAsync({
        quality: 0.75,
        // EXIF is stripped server-side during preprocessing; skipping it here
        // saves a serialisation pass on large photos.
        exif: false,
        skipProcessing: false,
      });

      if (!photo?.uri) {
        toast('Could not capture the photo', 'error');
        return;
      }

      await upload(photo.uri);
    } catch (error) {
      log.error('Capture failed', error);
      toast('Could not capture the photo', 'error');
      setPhase('viewfinder');
    }
  }, [upload]);

  const handlePickFromLibrary = useCallback(async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        toast('Photo library access is needed to pick an image', 'warning');
        return;
      }

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
        allowsEditing: false,
      });

      if (picked.canceled || !picked.assets?.[0]?.uri) return;
      await upload(picked.assets[0].uri);
    } catch (error) {
      log.error('Library pick failed', error);
      toast('Could not open the photo library', 'error');
    }
  }, [upload]);

  const handleRequestPermission = useCallback(async () => {
    const result = await requestPermission();
    if (result.granted) {
      setPhase('viewfinder');
      return;
    }
    // Denied twice: the OS will not ask again, so point at Settings.
    if (!result.canAskAgain) {
      toast('Enable camera access in Settings to scan your fridge', 'warning', {
        action: { label: t('openSettings'), onPress: () => void Linking.openSettings() },
        durationMs: 6000,
      });
    }
  }, [requestPermission, t]);

  // --- Permission gate -----------------------------------------------------
  if (phase === 'permission' || (permission && !permission.granted && !permission.canAskAgain)) {
    return (
      <Screen testID="scan-screen" header={{ title: t('title') }}>
        <EmptyState
          icon="camera-outline"
          tone="primary"
          title={t('permissionTitle')}
          description={t('permissionBody')}
          actionLabel={permission?.canAskAgain ? 'Allow camera' : t('openSettings')}
          onAction={() => (permission?.canAskAgain ? void handleRequestPermission() : void Linking.openSettings())}
          secondaryLabel="Pick from library instead"
          onSecondary={() => void handlePickFromLibrary()}
          testID="scan-permission"
        />
      </Screen>
    );
  }

  // --- Uploading -----------------------------------------------------------
  if (phase === 'uploading') {
    return (
      <Screen testID="scan-screen" header={{ title: t('title') }}>
        <Card padding="xl" style={{ gap: spacing.lg, alignItems: 'center' }} testID="scan-uploading">
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: radii.pill,
              backgroundColor: colors.primarySoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="scan" size={40} color={colors.primary} />
          </View>

          <View style={{ gap: spacing.xs, alignItems: 'center' }}>
            <Text variant="headingMedium" align="center">
              {t('processing')}
            </Text>
            <Text variant="bodySmall" tone="secondary" align="center">
              {t('processingHint')}
            </Text>
          </View>

          <View style={{ gap: spacing.sm, alignSelf: 'stretch' }}>
            <ProcessingStep label={t('processingStepUpload')} done />
            <ProcessingStep label={t('processingStepVision')} active />
            <ProcessingStep label={t('processingStepMatching')} />
          </View>

          <Text variant="captionSmall" tone="tertiary" align="center">
            Timeout {Math.round(config.uploadTimeoutMs / 1000)}s
          </Text>
        </Card>
      </Screen>
    );
  }

  // --- Viewfinder ----------------------------------------------------------
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }} testID="scan-screen">
      <CameraView
        ref={cameraRef}
        style={{ flex: 1 }}
        facing="back"
        // A fridge interior is dim and the useful detail is close up.
        pictureSize={Platform.OS === 'android' ? '1920x1080' : '1280x720'}
        animateShutter={false}
        enableTorch={false}
      />

      {/* Framing overlay: tells the user what to fill the frame with. */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'space-between' }}>
        <View style={{ paddingTop: spacing.huge, paddingHorizontal: spacing.lg, alignItems: 'center' }}>
          <View
            style={{
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radii.pill,
              backgroundColor: 'rgba(0,0,0,0.55)',
            }}
          >
            <Text variant="caption" style={{ color: colors.textInverse }} align="center">
              Open the fridge and fill the frame with your shelves
            </Text>
          </View>
        </View>

        {/* Corner guides */}
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ width: 260, height: 300, borderColor: 'rgba(255,255,255,0.55)', borderWidth: 3, borderRadius: radii.lg }} />
        </View>

        <View style={{ paddingBottom: spacing.xxxl, paddingHorizontal: spacing.lg, gap: spacing.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly' }}>
            <Button
              label=""
              icon="images-outline"
              variant="ghost"
              onPress={() => void handlePickFromLibrary()}
              accessibilityLabel={t('chooseFromLibrary')}
              style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: radii.pill }}
            />

            {/* Shutter */}
            <Button
              label=""
              onPress={() => void handleCapture()}
              accessibilityLabel={t('capture')}
              testID="scan-shutter"
              style={{
                width: 76,
                height: 76,
                borderRadius: radii.pill,
                backgroundColor: colors.surface,
                borderWidth: 5,
                borderColor: colors.primary,
                zIndex: zIndex.content,
              }}
            />

            <Button
              label=""
              icon="help-circle-outline"
              variant="ghost"
              onPress={() => router.push('/settings/about')}
              accessibilityLabel="How scanning works"
              style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: radii.pill }}
            />
          </View>

          <Text variant="captionSmall" style={{ color: 'rgba(255,255,255,0.8)' }} align="center">
            Photos are processed to identify ingredients, then deleted from the model provider.
          </Text>
        </View>
      </View>
    </View>
  );
}

function ProcessingStep({ label, done = false, active = false }: { label: string; done?: boolean; active?: boolean }): React.ReactElement {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <Ionicons
        name={done ? 'checkmark-circle' : active ? 'radio-button-on' : 'ellipse-outline'}
        size={sizes.iconSm}
        color={done ? colors.success : active ? colors.primary : colors.borderStrong}
      />
      <Text variant="bodySmall" tone={done ? 'tertiary' : active ? 'default' : 'tertiary'} style={{ flex: 1 }}>
        {label}
      </Text>
      {active ? <Ionicons name="ellipsis-horizontal" size={sizes.iconSm} color={colors.primary} /> : null}
    </View>
  );
}
