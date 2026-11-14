import { View, StyleSheet, Pressable } from "react-native";
import { AppText as Text } from "./AppText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing } from "../lib/theme";

interface HeaderProps {
  onBack?: () => void;
  title?: string;
}

export function Header({ onBack, title = "가는 김에" }: HeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.content}>
        {/* 좌측: 뒤로가기 버튼 */}
        <View style={styles.left}>
          {onBack && (
            <Pressable onPress={onBack} style={styles.backButton}>
              <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
            </Pressable>
          )}
        </View>

        {/* 중앙: 서비스명을 텍스트로 표시해 헤더 안에 여백을 확보 */}
        <Text style={styles.logo}>{title}</Text>

        {/* 우측: 균형용 빈 공간 */}
        <View style={styles.right} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 48,
    paddingHorizontal: spacing.md,
  },
  left: {
    width: 48,
    alignItems: "flex-start",
  },
  right: {
    width: 48,
  },
  backButton: {
    padding: spacing.sm,
    marginLeft: -spacing.sm,
  },
  logo: {
    fontSize: 18,
    lineHeight: 24,
    color: colors.primary,
    fontWeight: "600",
  },
});
