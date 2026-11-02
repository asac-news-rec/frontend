
const panel = document.querySelector('#visitor');
let profile = null;
let message = '';
let busy = false;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

async function api(action, body) {
  const response = await fetch(`/api/v1/visitors/${action}`, {
    method:body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store',
    headers:body === undefined ? {} : {'Content-Type':'application/json'},
    body:body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('방문자 저장 서버에 연결하지 못했습니다. npm start로 실행한 화면인지 확인하고 다시 시도해 주세요.');
  return (await response.json()).data;
}

function render() {
  panel.innerHTML = `<h2>이 브라우저의 방문자 정보</h2>
    <p>쿠키에는 임의의 식별 표식만 저장하고, 방문자 ID와 생성·최근 방문·만료 시각만 이 앱의 서버에 저장합니다. 표식의 유효기간은 30일입니다. 좋아요는 방문자 ID에 연결해 서버에 저장합니다. 이름·이메일·기사 클릭·읽기 시간은 수집하지 않습니다. 쿠키 삭제 시 이전 방문자와 연결할 수 없습니다.</p>
    ${profile ? `<p>방문자 ID <code>${escape(profile.reader_id)}</code></p>
      <p>저장 만료 ${escape(new Date(profile.expires_at).toLocaleString('ko-KR'))}</p>
      <button id="visitor-reset">방문자 표식과 서버 정보 삭제</button>
      <p>이 브라우저의 좋아요를 피드 정렬에 참고합니다. 기사는 가상 데이터이며 학습 모델은 아직 연결하지 않았습니다.</p>` :
      '<button id="visitor-start">이 브라우저에서 저장 시작</button><p>저장하지 않아도 아래 가상 뉴스 화면을 둘러볼 수 있습니다.</p>'}
    <p role="status">${escape(message)}</p>`;
  panel.querySelectorAll('button, input').forEach(element => {element.disabled = busy;});
  panel.querySelector('#visitor-start')?.addEventListener('click', () => run(async () => {
    const start = async () => {
      const existing = await api('me');
      if (!existing) await api('bootstrap', {});
      return api('me');
    };
    profile = navigator.locks ? await navigator.locks.request('news-visitor-bootstrap', start) : await start();
    if (!profile) throw new Error('쿠키를 저장하지 못했습니다. 브라우저의 쿠키 설정을 확인해 주세요.');
    message = '방문자 정보 저장을 시작했습니다. 같은 브라우저로 다시 방문하면 이 ID를 사용합니다.';
  }));
  panel.querySelector('#visitor-reset')?.addEventListener('click', () => run(async () => {
    await api('reset', {});
    window.dispatchEvent(new Event('visitor-reset'));
    profile = null;
    message = '서버의 방문자 정보와 브라우저의 표식을 삭제했습니다.';
  }));
}

async function run(action) {
  if (busy) return;
  const previousId=profile?.reader_id;
  busy = true;
  render();
  try {await action();} catch (error) {message = error.message;}
  finally {busy = false; render();if(previousId!==profile?.reader_id)window.dispatchEvent(new Event('visitor-changed'));}
}

await run(async () => {
  profile = await api('me');
  if (profile) {
    profile = await api('bootstrap', {});
    message = '이 브라우저의 이전 방문자 정보를 불러왔습니다.';
  }
});

export async function ensureVisitor() {
  if(busy)throw new Error('방문자 정보를 처리 중입니다.');
  const existing=await api('me');
  if(existing)return existing;
  if(!window.confirm('좋아요를 기억하려면 이 브라우저에 30일간 방문자 표식을 저장합니다. 좋아요는 서버에 저장하며 쿠키 삭제·만료 또는 다른 기기에서는 연결되지 않습니다. 저장을 시작할까요?'))return null;
  await run(async()=>{
    const start=async()=>{if(!await api('me'))await api('bootstrap',{});return api('me');};
    profile=navigator.locks?await navigator.locks.request('news-visitor-bootstrap',start):await start();
    if(!profile)throw new Error('방문자 표식을 저장하지 못했습니다.');
    message='이 브라우저에서 좋아요를 기억합니다.';
  });
  if(!profile)throw new Error('방문자 저장을 시작하지 못했습니다.');
  return profile;
}
