import { useState } from "react";
import { Alert, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";

export default function HomeScreen() {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.eyebrow}>가는김에</Text>
        <Text style={styles.title}>가는 길에{`\n`}밥집 찾기</Text>
        <Text style={styles.description}>
          출발지와 도착지를 입력하면 대중교통 경로와 그 길에 있는 식당을 찾아드려요.
        </Text>

        <View style={styles.form}>
          <TextInput
            accessibilityLabel="출발지"
            onChangeText={setOrigin}
            placeholder="출발지"
            placeholderTextColor="#8C929B"
            style={styles.input}
            value={origin}
          />
          <View style={styles.connector} />
          <TextInput
            accessibilityLabel="도착지"
            onChangeText={setDestination}
            placeholder="도착지"
            placeholderTextColor="#8C929B"
            style={styles.input}
            value={destination}
          />
        </View>

        <Pressable
          accessibilityRole="button"
          disabled={!origin.trim() || !destination.trim()}
          onPress={() => Alert.alert("아직 준비 중이에요", "길찾기 API를 연결하면 사용할 수 있어요.")}
          style={({ pressed }) => [
            styles.button,
            (!origin.trim() || !destination.trim()) && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.buttonText}>경로 찾기</Text>
        </Pressable>
        <Text style={styles.note}>서울 지역 · 60분 미만 경로</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F7F8FA" },
  container: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  eyebrow: { color: "#257A58", fontSize: 15, fontWeight: "700", marginBottom: 16 },
  title: { color: "#171A1F", fontSize: 36, fontWeight: "800", lineHeight: 44 },
  description: { color: "#626A75", fontSize: 16, lineHeight: 24, marginTop: 14, marginBottom: 32 },
  form: { backgroundColor: "#FFFFFF", borderColor: "#E4E7EB", borderRadius: 16, borderWidth: 1, paddingHorizontal: 16 },
  input: { color: "#171A1F", fontSize: 17, height: 58 },
  connector: { backgroundColor: "#E4E7EB", height: 1 },
  button: { alignItems: "center", backgroundColor: "#247A58", borderRadius: 14, height: 56, justifyContent: "center", marginTop: 16 },
  buttonDisabled: { backgroundColor: "#AFC7BC" },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  note: { color: "#858C95", fontSize: 13, marginTop: 14, textAlign: "center" },
});
