import { Text as NativeText, StyleSheet, type TextProps } from "react-native";
import { appFontFamily } from "../lib/theme";

export function AppText({ style, ...props }: TextProps) {
  return <NativeText {...props} style={[styles.default, style]} />;
}

const styles = StyleSheet.create({
  default: {
    fontFamily: appFontFamily,
  },
});
