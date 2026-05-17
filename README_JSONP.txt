# JSONP 적용 파일

## 왜 필요한가

GitHub Pages의 PWA가 Apps Script Web App을 fetch()로 직접 호출하면
브라우저 CORS 정책 때문에 `Failed to fetch`가 날 수 있습니다.

이번 파일은 그 문제를 피하기 위해 JSONP 방식으로 바꾼 버전입니다.

## 업로드 위치

### Apps Script
- Code_jsonp.gs 내용을 기존 Code.gs 전체에 덮어쓰기
- 저장
- 배포 → 배포 관리 → 수정 → 새 버전 → 배포

### GitHub 저장소 루트
아래 파일을 덮어쓰기/추가하세요.

- app.js
- config.json
- index.html
- service-worker.js

## config.json

config.json에는 `/exec`까지만 넣습니다.

예:

{
  "apiUrl": "https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxx/exec",
  "token": "my-stock-viewer-1234",
  "smallWeightThreshold": 0.01
}

`?action=dashboard&token=...&callback=...` 부분은 app.js가 자동으로 붙입니다.

## 개발 중 캐시

- app.js는 config.json을 매번 캐시 우회해서 읽습니다.
- index.html은 app.js도 매번 캐시 우회해서 불러옵니다.
- service-worker.js는 기존 캐시 제거용입니다.
