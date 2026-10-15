import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { colors } from '../../theme/tokens.js';

/**
 * Auth stack.
 *
 * Kept separate from the tab stack so a sign-out cannot leave a mounted tab
 * navigator holding cached user data behind it.
 */
export default function AuthLayout(): React.ReactElement {
  const router = useRouter();

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTransparent: true,
        headerTitle: '',
        headerBackTitle: 'Back',
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="register" options={{ headerShown: false }} />
      <Stack.Screen
        name="forgot-password"
        options={{
          headerShown: true,
          headerBackVisible: true,
          presentation: 'card',
          // The transparent header used by the other two screens would leave the
          // back button floating over content here.
          headerTransparent: false,
          headerStyle: { backgroundColor: colors.background },
        }}
      />
    </Stack>
  );
}
