import { View, StyleSheet, Pressable } from "react-native";
import { AppText as Text } from "./AppText";
import { colors, typography, spacing, radius } from "../lib/theme";

interface LegInfo {
  type: "WALK" | "BUS" | "SUBWAY";
  time: number; // 분
  vehicleName?: string;
  vehicleType?: string;
}

interface RouteCardProps {
  duration: number; // 분
  walkTime: number; // 분
  transfers: number;
  legs: LegInfo[];
  selected?: boolean;
  onPress: () => void;
}

export function RouteCard({
  duration,
  walkTime,
  transfers,
  legs,
  selected = false,
  onPress,
}: RouteCardProps) {
  const segments = buildSegments(legs, walkTime);
  const transitLegs = legs.filter((leg) => leg.type !== "WALK" && leg.vehicleName);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.container,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
    >
      {/* 헤더: 총 시간, 환승/도보 정보 */}
      <View style={styles.header}>
        <Text style={styles.duration}>{duration}분</Text>
        <View style={styles.meta}>
          <Text style={styles.metaText}>
            환승 {transfers > 0 ? `${transfers}회` : "없음"}
          </Text>
          {walkTime > 0 && (
            <>
              <Text style={styles.metaDot}>·</Text>
              <Text style={styles.metaText}>도보 {walkTime}분</Text>
            </>
          )}
        </View>
      </View>

      {/* 타임라인 바 */}
      <View style={styles.timeline}>
        {segments.map((seg, index) => (
          <View
            key={index}
            style={[
              styles.segment,
              seg.type === "WALK" ? styles.walkSegment : styles.busSegment,
              { flex: Math.max(seg.time, 3) }, // 최소 flex 3
            ]}
          >
            <Text
              style={seg.type === "WALK" ? styles.walkLabel : styles.busLabel}
              numberOfLines={1}
            >
              {seg.type === "WALK" ? `${seg.time}분` : seg.vehicleName || `${seg.time}분`}
            </Text>
          </View>
        ))}
      </View>

      {/* 버스 상세 (번호 + 시간) */}
      {transitLegs.length > 0 && (
        <View style={styles.busDetails}>
          {transitLegs.map((leg, index) => (
            <View key={index} style={styles.busDetail}>
              <Text style={styles.busDetailNo}>
                {leg.type === "BUS" ? "버스" : "지하철"} {leg.vehicleName}
              </Text>
              <Text style={styles.busDetailTime}>{leg.time}분</Text>
            </View>
          ))}
        </View>
      )}
    </Pressable>
  );
}

function buildSegments(
  legs: LegInfo[],
  walkTime: number
): Array<{ type: LegInfo["type"]; time: number; vehicleName?: string }> {
  const segments: Array<{ type: LegInfo["type"]; time: number; vehicleName?: string }> = [];

  const walkPerEnd = Math.round(walkTime / 2);
  const startWalk = walkPerEnd;
  const endWalk = walkTime - startWalk;

  if (startWalk > 0) {
    segments.push({ type: "WALK", time: startWalk });
  }

  for (const leg of legs) {
    segments.push({ type: leg.type, time: leg.time, vehicleName: leg.vehicleName });
  }

  if (endWalk > 0) {
    segments.push({ type: "WALK", time: endWalk });
  }

  return segments;
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  selected: {
    borderColor: colors.primary,
    borderWidth: 2,
    backgroundColor: colors.primaryLight,
  },
  pressed: {
    backgroundColor: colors.primaryLight,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  duration: {
    ...typography.title,
    color: colors.textPrimary,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
  },
  metaText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  metaDot: {
    ...typography.caption,
    color: colors.textSecondary,
    marginHorizontal: spacing.xs,
  },
  timeline: {
    flexDirection: "row",
    height: 32,
    gap: 3,
  },
  segment: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    minWidth: 36,
  },
  walkSegment: {
    backgroundColor: colors.border,
  },
  busSegment: {
    backgroundColor: colors.primary,
  },
  walkLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  busLabel: {
    ...typography.caption,
    color: colors.surface,
    fontWeight: "600",
  },
  busDetails: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  busDetail: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  busDetailNo: {
    ...typography.body,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  busDetailTime: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});
