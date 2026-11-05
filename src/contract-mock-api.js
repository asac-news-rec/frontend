/* Shared by the standalone browser demo and Node contract tests. */
(function (root) {
  const uuid = () => crypto.randomUUID();
  const fail = code => { throw new Error(code); };
  const clone = value => JSON.parse(JSON.stringify(value));
  function createMockApi() {
    const stored = new Map(), served = new Set(), cursors = new Map();
    let offline = false;
    const articles = ['도서관의 AI 교육', '도시의 작은 숲', '주말 러닝', '지역 미술 전시', '새로운 우주 관측', '우리 동네 산책'].map((title, i) => ({
      article_id: `mock-a${i + 1}`, title, subtitle: null, summary: '계약 검증용 가상 기사입니다.',
      paragraphs: ['화면 검증용 첫 번째 문단입니다.', '실제 보도가 아닌 가상 본문입니다.'],
      tags: ['모의'], category: i % 2 ? '생활' : 'IT·과학', subcategory: null,
      published_at: '2026-11-02T00:00:00.000Z', author: null, publisher: '시연 편집부',
      language: 'ko-KR', is_synthetic: true, image_url: null, image_caption: null
    }));
    return {
      setOffline(value) { offline = value; },
      async getFeed(input) {
        if (offline) fail('MOCK_OFFLINE');
        if (!input || Object.keys(input).some(k => !['reader_id', 'cursor'].includes(k)) || typeof input.reader_id !== 'string' || !input.reader_id || !(input.cursor === null || typeof input.cursor === 'string')) fail('INVALID_FEED_REQUEST');
        const state = input.cursor === null ? {offset: 0, user: input.reader_id} : cursors.get(input.cursor);
        if (!state || state.user !== input.reader_id) fail('INVALID_CURSOR');
        const items = articles.slice(state.offset, state.offset + 3).map((a, i) => {
          const impression_id = 'mock-' + uuid(); served.add(impression_id);
          return {...a, impression_id, position: state.offset + i + 1};
        });
        const next_cursor = state.offset + 3 < articles.length ? 'mock-cursor-' + uuid() : null;
        if (next_cursor) cursors.set(next_cursor, {offset: state.offset + 3, user: input.reader_id});
        return clone({request_id: 'mock-request-' + uuid(), served_at: new Date().toISOString(), items, next_cursor});
      },
      async send(input) {
        if (offline) fail('MOCK_OFFLINE');
        if (!input || Object.keys(input).join() !== 'events' || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 100) fail('INVALID_ENVELOPE');
        const batch = input.events.map(e => {
          const fields = ['event_id', 'event_type', 'event_time', 'impression_id', 'page_type', 'duration_ms', 'ended_at'];
          if (!e || Object.keys(e).some(k => !fields.includes(k)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.event_id) || !served.has(e.impression_id) || !['list', 'detail'].includes(e.page_type) || !['exposure', 'article_open', 'article_close', 'like', 'unlike'].includes(e.event_type)) fail('INVALID_EVENT');
          const time = v => typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
          if (!time(e.event_time)) fail('INVALID_TIME');
          if (e.event_type === 'exposure') {
            if (e.page_type !== 'list' || !Number.isInteger(e.duration_ms) || e.duration_ms < 1 || !time(e.ended_at) || Date.parse(e.ended_at) < Date.parse(e.event_time)) fail('INVALID_EXPOSURE');
          } else if ('duration_ms' in e || 'ended_at' in e || (e.event_type === 'article_open' && e.page_type !== 'list') || (e.event_type === 'article_close' && e.page_type !== 'detail')) fail('INVALID_CLICK');
          const body = JSON.stringify(Object.fromEntries(Object.entries(e).sort(([a], [b]) => a.localeCompare(b))));
          return {e, body};
        });
        const check = new Map(stored);
        for (const {e, body} of batch) {
          if (check.has(e.event_id) && check.get(e.event_id) !== body) fail('EVENT_ID_CONFLICT');
          check.set(e.event_id, body);
        }
        const results = batch.map(({e, body}) => {
          const status = stored.has(e.event_id) ? 'duplicate' : 'accepted'; stored.set(e.event_id, body);
          return {event_id: e.event_id, status};
        });
        return {results}; // Mock ACK only; production response remains unconfirmed.
      },
      get storedCount() { return stored.size; }
    };
  }
  root.NewsContractMock = {createMockApi};
})(globalThis);
