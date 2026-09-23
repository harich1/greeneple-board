# 그리네플 경영지원·회계 업무 게시판

GitHub Pages와 Supabase로 운영하는 소규모 사내 게시판입니다.

## 포함 기능

- 관리자 발급 아이디·비밀번호 로그인
- 게시글 작성, 열람, 수정, 삭제
- 게시글 조회수
- 댓글 및 한 단계 답글
- URL 자동 링크
- 작성자 본인 및 관리자 권한
- 모바일 대응

## 구성

- `index.html`, `styles.css`, `app.js`: GitHub Pages 프론트엔드
- `config.js`: 공개용 Supabase 연결 정보

Supabase 스키마와 직원 계정 정보는 공개 저장소 밖에서 관리합니다.

비밀번호, 데이터베이스 비밀번호, Supabase secret/service role 키를 저장소에 넣지 마세요.
