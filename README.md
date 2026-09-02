# 도면자동화 v0.8.0

DWG/DXF 도면 렌더링과 변경 비교, 문서 기반 설계 검토, DWG → DXF 변환,
층별 장비 위치 관리를 제공하는 로컬 웹 애플리케이션입니다.

전체 아키텍처, 데이터 흐름, 알고리즘, API와 유지보수 방법은
[`TECHNICAL_DOCUMENT.md`](TECHNICAL_DOCUMENT.md)에서 확인할 수 있습니다.

## 주요 기능

### 도면 비교

- DWG/DXF 두 도면을 좌우에서 동시에 렌더링
- DXF 객체의 추가·삭제·변경 목록 생성
- 검토 항목을 클릭하여 해당 좌표로 이동
- 확대·이동·전체 보기 및 좌우 화면 동기화
- 기준점, 문자 및 블록 앵커를 이용한 자동 정렬
- 원본·변경본 겹쳐보기와 투명도 조절
- 검토 결과 CSV 내보내기
- ANSI 949/CP949 및 잘못 선언된 UTF-8 DXF 한글 보정

### 문서 기반 도면 검토

- DXF/PDF 검토 도면 업로드
- PDF·DOCX·TXT 시방서와 자재승인서 다중 업로드
- 재질·치수·규격·수량·모델명 등 요구사항 후보 추출
- 도면 문자와 문서 요구사항 대조 및 근거 문장 표시
- 결과를 클릭하여 관련 PDF 페이지 또는 DXF 좌표로 이동
- 많은 문서를 파일별 한 줄 목록으로 표시하고 목록 내부에서 스크롤

### DWG → DXF 변환

- DWG 파일을 최대 50개까지 일괄 변환
- 한 파일은 원본 파일명을 유지한 DXF로 다운로드
- 여러 파일은 사용자가 지정한 이름의 ZIP으로 다운로드
- ODA File Converter 설치 경로 자동 탐지

### 층별 장비 위치

- 층별 DXF 원본 파일명, 사용자 지정 표시명 및 설명 저장
- 장비 목록과 장비 종류별 필터 버블 제공
- 장비를 클릭하여 도면상의 해당 위치로 이동
- 분석 결과와 원본 DXF를 브라우저 IndexedDB에 저장
- 분석 규칙이 갱신되면 저장된 도면을 자동 재분석
- 대용량 DXF 텍스트 분석을 Web Worker에서 실행

주요 장비 분류에는 UPS, STS, CTTS, Battery, LV, HV, TR, SC, RF, CRAH, CWU,
ODU, FC, 버퍼탱크, MTR, T/L PRO, BUS PRO, BUS TIE, AC & B/C,
BATT & DC, MOF, RTU 등이 포함됩니다.

일반 층의 `5F-1D-3` 형식뿐 아니라 6층의 `CR-2-1`, `CR-3-PT`,
`CRB-1-13` 형식도 판넬명으로 인식합니다. BT 약어는 분석에 사용하지만
화면의 장비 분류에는 `버퍼탱크`로 표시하며 `A-6F-BT-01` 같은 원본 태그는 유지합니다.

장비 사전은 `public/equipment-priority.json`, 위치 및 판넬 연결 규칙은
`src/features/equipment/analysis.js`에서 관리합니다.

## 요구 환경

- Windows 10/11
- Node.js 20.19 이상
- Python 3
- DWG → DXF 변환 기능 사용 시 ODA File Converter

Python 패키지는 `requirements.txt`, 프런트엔드 패키지는 `package.json`에 정의되어 있습니다.

## 설치 및 실행

Windows에서는 프로젝트 폴더의 `run-app.bat`을 실행하는 것이 가장 간단합니다.
배치파일이 Node.js와 Python을 확인하고, 필요한 경우 npm 패키지를 설치한 뒤 빌드와 서버 실행을 진행합니다.

직접 실행하려면 다음 명령을 사용합니다.

```powershell
python -m pip install -r requirements.txt
npm install
npm start
```

서버가 시작되면 브라우저에서 `http://127.0.0.1:8000`으로 접속합니다.
소스 HTML을 파일로 직접 열거나 일반 Live Server로 제공하면 npm 모듈과 WebAssembly를
정상적으로 불러올 수 없으므로 반드시 위 서버 또는 Vite 개발 서버를 사용해야 합니다.

프런트엔드 개발 서버만 실행하려면 다음 명령을 사용합니다.

```powershell
npm run dev
```

## 페이지 구성

- `/index.html`: 도면 비교
- `/review.html`: 문서 기반 도면 검토
- `/convert.html`: DWG → DXF 변환
- `/render-test.html`: 층별 장비 위치

실제 보조 페이지 HTML은 `pages/`에 있으며, Python 서버가 기존 주소와의 호환 경로를 제공합니다.

## ODA File Converter 설정

서버는 `C:\Program Files\ODA\ODAFileConverter 버전\` 형태의 설치 폴더를 자동 탐지합니다.
자동 탐지가 되지 않으면 `ODA_FILE_CONVERTER` 환경 변수에 실행 파일 또는 설치 폴더를 지정합니다.

```powershell
$env:ODA_FILE_CONVERTER = "C:\Program Files\ODA\ODAFileConverter 27.1.0"
npm start
```

ODA는 DWG → DXF 변환에만 사용됩니다. 브라우저의 DWG 렌더링은
`@mlightcad/cad-simple-viewer`와 LibreDWG WebAssembly를 사용합니다.

## 테스트와 빌드

```powershell
npm test
npm run build
```

- `npm test`: 프런트엔드 분석/비교 회귀 테스트와 Python 서버 테스트 실행
- `npm run build`: Vite 프로덕션 빌드 생성
- Python 서버는 `dist/index.html`이 있으면 빌드 결과를 우선 제공합니다.

CAD 렌더러 번들은 WebAssembly와 뷰어 라이브러리를 포함하므로 Vite의 500kB 청크 경고가
표시될 수 있습니다. 현재는 빌드 실패가 아닌 성능 참고 경고입니다.

## 프로젝트 구조

- `app.js`: 도면 비교 화면 진입점
- `pages/`: 비교 외 페이지 HTML
- `src/features/compare/`: 비교 화면, 비교 엔진 및 SVG 생성
- `src/features/review/`: 문서 기반 검토 화면
- `src/features/convert/`: DWG 변환 화면
- `src/features/equipment/`: 층별 장비 화면, 분석 및 IndexedDB 저장
- `src/shared/`: CAD 연결, DXF 인코딩·문자 정리 및 공통 UI 함수
- `src/cad/`: iframe 내부 고성능 CAD 렌더러
- `src/workers/`: 대용량 DXF 백그라운드 분석 Worker
- `public/cad-assets/`: LibreDWG Worker 및 WebAssembly
- `public/cad-data/fonts/`: CAD 한글 렌더링용 글꼴
- `server_modules/`: 업로드, 문서 추출, PDF 비교, DWG 변환 및 HTTP 처리
- `tests/frontend/`: 프런트엔드 회귀 테스트
- `tests/server/`: Python 서버 회귀 테스트
- `server.py`: 로컬 HTTP/API 서버 진입점

## 업로드 크기

기본적으로 업로드 용량을 제한하지 않습니다. 운영 환경에서 제한이 필요하면
`DRAWING_AUTOMATION_MAX_UPLOAD` 환경 변수에 바이트 단위 상한을 지정합니다.

```powershell
$env:DRAWING_AUTOMATION_MAX_UPLOAD = 1073741824
npm start
```

## 현재 제한 사항 및 고도화 후보

- DWG는 브라우저에서 렌더링할 수 있지만 객체 단위 변경 목록 계산은 DXF 중심입니다.
- 바이너리 DXF는 변경 목록 계산을 지원하지 않으므로 ASCII DXF가 필요합니다.
- 지원하지 않는 사용자 정의 CAD 객체는 화면에 완전히 표현되지 않을 수 있습니다.
- 장비 설명 문장이나 반복 블록이 실제 장비 후보로 중복 검출될 수 있습니다.
- `A-6F-ODU-01~02` 같은 범위 태그를 개별 장비로 확장하는 기능은 아직 없습니다.
- 장비 태그 우선 판별, 설명 문장 제외 및 동일 실장비 중복 통합을 추가로 고도화할 수 있습니다.

LibreDWG 파서는 GPL-3.0 라이선스이며 관련 고지는 `THIRD_PARTY_NOTICES.md`와
`public/cad-assets/LICENSE-GPL-3.0.txt`에서 확인할 수 있습니다.
