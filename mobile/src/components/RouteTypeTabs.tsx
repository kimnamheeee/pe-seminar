import { ScrollView, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, spacing, typography } from "../lib/theme";

export type RouteTypeTabKey = "ALL" | "BUS" | "SUBWAY" | "BUS_AND_SUBWAY";

interface RouteTypeTabsProps {
  counts: Record<RouteTypeTabKey, number>;
  selected: RouteTypeTabKey;
  onSelect: (type: RouteTypeTabKey) => void;
}

const tabs: Array<{ key: RouteTypeTabKey; label: string }> = [
  { key: "ALL", label: "전체" },
  { key: "BUS", label: "버스" },
  { key: "SUBWAY", label: "지하철" },
  { key: "BUS_AND_SUBWAY", label: "버스 + 지하철" },
];

export function RouteTypeTabs({ counts, selected, onSelect }: RouteTypeTabsProps) {
  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabList}
      >
        {tabs.map((tab) => {
          const isSelected = selected === tab.key;
          const count = counts[tab.key];
          const isDisabled = count === 0;

          return (
            <Pressable
              key={tab.key}
              accessibilityRole="button"
              accessibilityLabel={`${tab.label} ${count}개 경로`}
              accessibilityState={{ selected: isSelected, disabled: isDisabled }}
              disabled={isDisabled}
              onPress={() => onSelect(tab.key)}
              style={({ pressed }) => [
                styles.tab,
                pressed && !isDisabled && styles.pressedTab,
              ]}
            >
              <View style={styles.tabContent}>
                <Text
                  style={[
                    styles.label,
                    isSelected && styles.selectedLabel,
                    isDisabled && styles.disabledLabel,
                  ]}
                >
                  {tab.label}
                </Text>
                <Text
                  style={[
                    styles.count,
                    isSelected && styles.selectedLabel,
                    isDisabled && styles.disabledLabel,
                  ]}
                >
                  {count}
                </Text>
              </View>
              {isSelected && <View style={styles.selectedIndicator} />}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.md,
  },
  tabList: {
    paddingHorizontal: spacing.lg,
  },
  tab: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    position: "relative",
  },
  tabContent: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  pressedTab: {
    opacity: 0.72,
  },
  selectedIndicator: {
    position: "absolute",
    bottom: 0,
    left: spacing.md,
    right: spacing.md,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.primary,
  },
  label: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: "500",
  },
  count: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  selectedLabel: {
    color: colors.textPrimary,
    fontWeight: "700",
  },
  disabledLabel: {
    color: colors.textSecondary,
    fontWeight: "400",
  },
});
