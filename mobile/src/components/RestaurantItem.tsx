import { View, Text, StyleSheet, Pressable } from "react-native";
import { colors, typography, spacing } from "../lib/theme";

interface RestaurantItemProps {
  name: string;
  category: string;
  address: string;
  distanceFromRoute: number; // 미터
  selected?: boolean;
  onPress: () => void;
}

export function RestaurantItem({
  name,
  category,
  address,
  distanceFromRoute,
  selected = false,
  onPress,
}: RestaurantItemProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.header}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.distance}>{distanceFromRoute}m</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.category}>{category}</Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.address} numberOfLines={1}>
          {address}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  selected: {
    backgroundColor: colors.primaryLight,
  },
  pressed: {
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  name: {
    ...typography.subtitle,
    color: colors.textPrimary,
    flex: 1,
    marginRight: spacing.sm,
  },
  distance: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: "600",
  },
  info: {
    flexDirection: "row",
    alignItems: "center",
  },
  category: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  dot: {
    ...typography.caption,
    color: colors.textSecondary,
    marginHorizontal: spacing.xs,
  },
  address: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
});
