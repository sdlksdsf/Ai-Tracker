import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { DMSans_500Medium, DMSans_700Bold } from '@expo-google-fonts/dm-sans';
import * as SplashScreen from 'expo-splash-screen';
import { View, ActivityIndicator } from 'react-native';
import { queryClient } from '../lib/query.js';
import { colors } from '../theme/tokens.js';
import { ToastHost } from '../components/ui/Toast.js';
import { useAuthStore, wireSessionExpiry } from '../stores/auth.store.js';
import '../i18n/index.js';

/**
 * Root layout.
 *
 * Owns everything that must exist exactly once: the font loader, the query
 * client, the safe-area provider, the auth bootstrap and the toast host.
 *
 * The splash screen is held until BOTH the fonts and the auth bootstrap have
 * finished. Releasing it earlier is what causes the two worst first-launch
 * artefacts — a frame of unstyled system-font text, and a flash of the login
 * screen for a user who is actually signed in.
 */

// Keep the native splash visible while we boot; we hide it explicitly below.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout(): React.ReactElement | null {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    DMSans_500Medium,
    DMSans_700Bold,
  });

  const status = useAuthStore((state) => state.status);
  const bootstrap = useAuthStore((state) => state.bootstrap);

  // Read stored tokens once per app launch.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Route a dead refresh token to the auth stack, wherever the user is.
  useEffect(() => wireSessionExpiry(), []);

  useEffect(() => {
    // A font load failure must not hang the app forever — fall back to system
    // fonts rather than showing a splash screen until the user kills the app.
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.textInverse} />
      </View>
    );
  }

  // Still deciding whether a session exists — keep the splash up rather than
  // flashing the login screen.
  if (status === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.textInverse} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="dark" />

          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
              animation: 'slide_from_right',
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="onboarding" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="pantry" />
            <Stack.Screen name="recipe/[id]" />
            <Stack.Screen name="cooking/[id]" options={{ animation: 'fade' }} />
            <Stack.Screen name="scan/result/[id]" />
            <Stack.Screen name="grocery/[id]" />
            <Stack.Screen name="waste" />
            <Stack.Screen name="achievements" />
            <Stack.Screen name="premium" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="settings/index" />
            <Stack.Screen name="settings/notifications" />
            <Stack.Screen name="settings/preferences" />
            <Stack.Screen name="settings/about" />
          </Stack>

          {/* Above the navigator so a toast from any screen is visible. */}
          <ToastHost />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
