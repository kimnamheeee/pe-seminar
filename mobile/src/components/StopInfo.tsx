import { View, Text, StyleSheet } from "react-native";
import { colors, typography, spacing, radius } from "../lib/theme";

interface StopInfoProps {
  found: boolean;
  stopName?: string;
  distanceFromRestaurant?: number;
}

export function StopInfo({
  found,
  stopName,
  distanceFromRestaurant,
}: StopInfoProps) {
  if (!found) {
    return (
      <View style={[styles.container, styles.notFound]}>
        <Text style={styles.notFoundText}>
          하차 정류장 정보를 찾지 못했습니다
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>하차 정류장</Text>
      <Text style={styles.stopName}>{stopName}</Text>
      {distanceFromRestaurant !== undefined && (
        <Text style={styles.distance}>
          식당까지 약 {distanceFromRestaurant}m
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  notFound: {
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  label: {
    ...typography.small,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  stopName: {
    ...typography.subtitle,
    color: colors.textPrimary,
  },
  distance: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  notFoundText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: "center",
  },
});
