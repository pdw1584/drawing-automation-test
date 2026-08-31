# 도면자동화 v0.1

DWG/DXF 도면을 브라우저에서 렌더링하고, DXF 변경 위치를 좌우 도면과 목록에서 확인하는 프로토타입입니다.

## 실행

Windows에서는 프로젝트 폴더의 `run-app.bat`을 더블클릭하면 의존성 확인, 빌드, 서버 실행이 순서대로 진행됩니다.

직접 실행하려면 다음 명령을 사용합니다.

```powershell
python -m pip install -r requirements.txt
npm install
npm start
```

## 주요 코드 구조

- `app.js`: 기존 HTML 경로를 유지하는 도면 비교 진입점
- `pages/`: 비교 외 화면의 HTML 문서
- `src/features/compare/`: 도면 비교 화면, 순수 비교 엔진, SVG 생성
- `src/features/review/`: 문서 기반 도면 검토 화면
- `src/features/convert/`: DWG → DXF 변환 화면
- `src/features/equipment/`: 층별 장비 화면, 장비 분석, IndexedDB 저장
- `src/shared/`: CAD iframe 연결, DXF 인코딩·문자 정리, 공통 UI 함수
- `src/cad/`: iframe 내부 CAD 렌더러
- `src/workers/`: 대용량 DXF 백그라운드 분석 Worker
- `server.py`: 정적 파일, 문서 검토, 변환 API 서버

이미 의존성을 설치했다면 다음 명령만 실행합니다.

```powershell
npm start
```

브라우저에서 `http://localhost:8000`을 열고 **샘플 불러오기** 또는 DWG/DXF 파일을 선택합니다.

## 페이지 구성

- `index.html`: DWG/DXF 두 도면 표시와 DXF 변경 비교
- `review.html`: DXF/PDF 도면과 시방서·자재승인서 대조
- `convert.html`: DWG 파일을 DXF로 변환
- `render-test.html`: 층별 DXF 등록, 장비명 추출 및 장비 위치 탐색
- DWG는 한 번에 최대 50개까지 선택할 수 있으며, 여러 결과는 ZIP으로 다운로드됩니다.
- 한 파일은 원본 이름의 DXF로 저장되고, 여러 파일은 사용자가 지정한 이름의 ZIP으로 저장됩니다.

DWG 변환에는 ODA File Converter가 필요합니다. `C:\Program Files\ODA\ODAFileConverter 버전\` 형태의 설치 폴더를 자동 탐지하며, 찾지 못하면 `ODA_FILE_CONVERTER` 환경 변수에 실행 파일이나 설치 폴더 경로를 지정합니다.

## 현재 지원

- ASCII DXF의 LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE, TEXT, MTEXT, INSERT, POINT
- ARC 시작·끝 각도, 닫힌/곡선 폴리라인, 문자 높이·회전, 기본 DIMENSION 표시
- BLOCKS/INSERT 내부 형상 전개, 삽입점·회전·축척·레이어 상속 및 중첩 블록 처리
- 추가·삭제·위치/문자/형상 변경 분류
- 좌우 동기화 확대, 이동, 전체 보기
- 변경 목록 필터와 클릭 위치 이동
- 공통 객체를 이용한 기준점 이동 자동 정렬
- 고유 문자·블록 앵커를 이용한 회전 및 축척 자동 정렬
- 빨강(원본)·초록(변경본) 겹쳐보기와 투명도 조절
- 검토 결과 CSV 내보내기
- PDF 페이지 렌더링 및 좌우 동기화
- PDF 픽셀 변경 영역과 페이지별 변경 목록
- PDF 텍스트 추가·삭제 정보 추출 기반
- PDF·DOCX·TXT 시방서 및 자재승인서 업로드
- 문서의 재질·치수·규격·수량·모델명 후보 추출
- 도면 문자와 요구사항 대조 및 근거 문장 표시
- 문서 요구사항과 일치하는 PDF 페이지 또는 DXF 문자 좌표 강조

## 제한 및 다음 단계

- DWG는 LibreDWG WebAssembly로 브라우저 렌더링하며, DWG 변경 목록 계산은 아직 지원하지 않습니다.
- 바이너리 DXF는 변경 목록 계산에서 지원하지 않습니다.
- DXF 비교 페이지는 ASCII DXF만 인식하며, 바이너리·ENTITIES 누락·지원 객체 0개인 파일은 화면에 원인을 표시합니다.
- 자동 정렬은 앵커가 충분하면 회전·축척·평행 이동을 함께 보정하고, 부족하면 평행 이동만 보정합니다.
- PDF 및 시방서 검토는 백엔드 문서 처리 파이프라인으로 추가할 예정입니다.
# 고성능 CAD 렌더러 빌드

도면 비교 화면은 `@mlightcad/cad-simple-viewer`와 LibreDWG WebAssembly를 사용합니다.
최초 실행 또는 프런트엔드 파일을 수정한 뒤 다음 명령으로 빌드합니다.

```powershell
npm install
npm start
```

Python 서버는 `dist/index.html`이 있으면 빌드 결과를 우선 제공합니다. DWG 파서는
GPL-3.0인 `@mlightcad/libredwg-converter`를 별도 Web Worker에서 실행합니다.

업로드 크기는 기본적으로 제한하지 않습니다. 운영 환경에서 상한이 필요하면
`DRAWING_AUTOMATION_MAX_UPLOAD` 환경 변수에 바이트 단위 제한값을 지정할 수 있습니다.

`index.html`을 파일로 직접 열거나 VS Code Live Server로 원본 폴더를 제공하면 npm의
bare module import를 해석할 수 없습니다. 전체 앱은 반드시 `npm start`로 실행하고
`http://127.0.0.1:8000`으로 접속합니다. 렌더러 UI만 개발할 때는 `npm run dev` 후
Vite가 표시하는 주소를 사용할 수 있습니다.
