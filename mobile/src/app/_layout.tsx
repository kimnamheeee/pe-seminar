import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import Animated, { FadeIn, FadeInUp, FadeOut } from "react-native-reanimated";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConvexClientProvider } from "../lib/convex";
import { colors, spacing, typography } from "../lib/theme";
import { AppText } from "../components/AppText";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [showBrandIntro, setShowBrandIntro] = useState(true);
  const [fontsLoaded, fontError] = useFonts({
    Pretendard: require("../../assets/fonts/PretendardVariable.ttf"),
  });
  const appReady = fontsLoaded || fontError !== null;

  useEffect(() => {
    if (appReady) void SplashScreen.hideAsync();
  }, [appReady]);

  useEffect(() => {
    if (!appReady) return;
    const timeout = setTimeout(() => setShowBrandIntro(false), 3000);
    return () => clearTimeout(timeout);
  }, [appReady]);

  if (!appReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ConvexClientProvider>
          <StatusBar style={showBrandIntro ? "light" : "dark"} />
          <View style={styles.root}>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
              }}
            />
            {showBrandIntro && (
              <Animated.View
                exiting={FadeOut.duration(420)}
                pointerEvents="auto"
                style={styles.brandIntro}
              >
                <Image
                  source={require("../../assets/branding/app-icon.png")}
                  style={styles.brandIntroLogo}
                  resizeMode="contain"
                />
                <Animated.View entering={FadeIn.delay(480).duration(560)}>
                  <AppText style={styles.brandIntroSlogan}>어차피 가는 길이라면,</AppText>
                </Animated.View>
                <Animated.View entering={FadeInUp.delay(1250).duration(720)}>
                  <AppText style={styles.brandIntroName}>가는 김에</AppText>
                </Animated.View>
              </Animated.View>
            )}
          </View>
        </ConvexClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  brandIntro: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#176B62",
    paddingHorizontal: spacing.xl,
  },
  brandIntroLogo: {
    width: 128,
    height: 128,
  },
  brandIntroSlogan: {
    ...typography.body,
    color: "#D4E8E4",
    textAlign: "center",
    marginTop: spacing.xl,
  },
  brandIntroName: {
    ...typography.title,
    fontSize: 32,
    lineHeight: 42,
    color: colors.surface,
    fontWeight: "700",
    textAlign: "center",
    marginTop: spacing.xs,
  },
});
