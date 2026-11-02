# 모바일 앱

Expo SDK 57과 Expo Router를 사용하는 React Native 앱입니다. 패키지 관리자는 Yarn이며, Metro 호환성을 위해 Yarn Plug'n'Play 대신 `node_modules` 링크 방식을 사용합니다.

## 실행

```sh
cd mobile
yarn install
yarn start
```

터미널에 표시되는 QR 코드를 Expo Go로 스캔하면 실제 기기에서 확인할 수 있습니다. iOS 시뮬레이터는 macOS와 Xcode가 필요합니다.

## 구성

- `src/app/`: Expo Router 화면과 레이아웃
- `src/features/`: 경로 선택 및 주변 식당 기능
- `src/components/`: 화면 간 공용 UI
- `src/lib/`: Convex 클라이언트 설정
- `convex/`: Kakao API를 호출할 서버 함수

Convex는 설치만 해둔 상태이며, 배포 URL과 Kakao API 키를 연결할 때 클라이언트와 서버 함수를 구성합니다. API 키는 모바일 앱에 넣지 않고 Convex 환경변수에 보관합니다.

환경변수 이름은 `.env.example`에 적혀 있습니다. Convex 연결 후 `.env.local`에 배포 URL을 설정합니다.
