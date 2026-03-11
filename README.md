# Local Screenshot to Figma 🚀

이 프로젝트는 웹사이트의 URL이나 HTML을 입력받아, 해당 페이지를 **Figma 네이티브 요소(Frame, Text, 이미지 등)**로 완벽하게 변환해주는 도구입니다. 

단순히 전체 화면을 하나의 이미지로 캡처하는 것이 아니라 웹 페이지의 DOM 구조, CSS 스타일(색상, 폰트, 여백, 그림자 등)을 분석하여 피그마에서 수정 가능한 형태로 렌더링합니다.

## 📂 프로젝트 구조

이 프로젝트는 크게 두 가지 핵심 모듈로 구성되어 있습니다.

1. **`screenshot-api` (서버 모듈)**
   - Node.js, Express, Puppeteer를 기반으로 작동하는 로컬 파싱 서버입니다.
   - 요청받은 URL 페이지로 이동하여 브라우저에서 렌더링된 요소들을 계산하고, CSS 속성 정보와 위치를 JSON 형태로 반환합니다.
   - 클릭이나 호버 같은 상호작용(Interaction) 설정 기능, 동적으로 숨겨진 요소 표시 등 복잡한 상태의 사이트 캡처도 지원합니다.
2. **`screenshot-plugin` (Figma 플러그인)**
   - Figma 내부에서 실행되는 플러그인입니다 (`manifest.json`, `ui.html`, `code.js`).
   - 사용자가 UI에 URL을 입력하면 로컬 서버(`screenshot-api`)로 데이터를 요청하고, 전달받은 JSON 트리를 바탕으로 Figma 캔버스 위에 실시간으로 UI를 그려냅니다.

---

## ✨ 주요 기능

- **하이브리드 파싱 지원**: 단순 텍스트, 컨테이너 요소는 Figma의 Frame과 Text 노드로 변환하며, `<img>`, `<canvas>`, `<svg>`, 복잡한 아이콘 폰트는 알아서 이미지나 SVG 원본으로 캡처합니다.
- **인터랙션/상태 지원 (Hover, Click)**: 지정한 셀렉터(Selector) 요소에 클릭이나 호버 액션을 취한 뒤 스크린샷을 찍을 수 있어, 드롭다운 메뉴나 모달 창까지 캡처가 가능합니다.
- **폰트/스타일 완벽 추출**: 텍스트 정렬, 굵기, 색상, Line-height, 상자 그림자(Box-shadow), 투명도 등 주요 CSS 속성을 Figma 요소에 적용합니다.

---

## 🛠 설치 및 실행 방법

### 1단계: API 서버 실행 (`screenshot-api`)

웹사이트를 분석할 로컬 서버를 먼저 실행해야 합니다.

```bash
cd screenshot-api
npm install
npm start
```

서버가 실행되면 콘솔에 `🚀 (V4 하이브리드) API 서버 실행 중...` 메시지와 함께 `http://localhost:3000`에서 대기합니다.

### 2단계: Figma 플러그인 등록 및 실행 (`screenshot-plugin`)

1. Figma 데스크톱 앱을 엽니다.
2. 상단 메뉴에서 **Plugins** > **Development** > **Import plugin from manifest...** 를 클릭합니다.
3. 프로젝트 내 `screenshot-plugin/manifest.json` 파일을 선택하여 로드합니다.
4. Figma 캔버스에서 우클릭 후 **Plugins** > **Development** > **Local Screenshot to Figma**를 실행합니다.
5. 플러그인 UI 창에 캡처하고 싶은 웹사이트의 URL을 입력하고 캡처 버튼을 누릅니다!

---

## ⚠️ 요구 사항 및 주의사항

- **Node.js**: `screenshot-api` 실행을 위해 Node.js 환경이 필요합니다.
- **모의/테스트용 프록시 지원**: iframe 관련 설정으로 인해 웹페이지 보안 제한(CORS/X-Frame-Options)을 회피하기 위한 로컬 프록시 미들웨어 설정이 서버에 포함되어 있습니다.
- 개발용 로컬 도구로 설계되었으므로 프로덕션 서버에 그대로 배포하는 것은 보안상 권장하지 않습니다.
