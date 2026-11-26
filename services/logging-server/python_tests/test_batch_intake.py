import time
from contextlib import closing
from uuid import uuid4

import pytest

from logging_service.schema import InputError, iso
from logging_service.store import Store


def exercise_batch(store):
    stamp = iso(int(time.time() * 1000))
    rows = [dict(request_id='batch', impression_id=f'imp-{i}', reader_id='reader',
                 article_id=f'a-{i}', position=i + 1, served_at=stamp) for i in range(20)]
    result = store.intake_served({'records': rows + [rows[0], {**rows[0], 'article_id': 'conflict'}]})['results']
    assert [r['status'] for r in result] == ['accepted'] * 20 + ['duplicate', 'rejected']
    assert result[-1]['code'] == 'IMPRESSION_ID_CONFLICT'
    assert store.counts()['served'] == 20
    assert all(r['status'] == 'duplicate' for r in store.intake_served({'records': rows})['results'])
    new = {**rows[0], 'impression_id': 'rollback'}
    with pytest.raises(InputError):
        store.intake_served({'records': [new, {**new, 'position': 0}]}, atomic=True)
    assert store.get('served_records', 'impression_id', 'rollback') is None
    events = [dict(event_id=str(uuid4()), impression_id=r['impression_id'], event_type='article_open',
                   event_time=stamp, page_type='list') for r in rows]
    result = store.intake_actions({'events': events + [{**events[0], 'event_id': events[0]['event_id'].upper()},
        {**events[0], 'event_type': 'like'}]}, 'reader', True)['results']
    assert [r['status'] for r in result] == ['accepted'] * 20 + ['duplicate', 'rejected']
    assert result[-1]['code'] == 'EVENT_ID_CONFLICT'
    assert store.counts()['actions'] == 20
    assert all(r['status'] == 'duplicate' for r in store.intake_actions({'events': events}, 'reader', True)['results'])
    with pytest.raises(OverflowError):
        store.intake_served({'records': [new]}, max_records=40)
    assert store.get('served_records', 'impression_id', 'rollback') is None
    with store.transaction():
        store.db.execute('INSERT INTO revoked_users VALUES(?,?)', ('reader', stamp))
    assert store.intake_served({'records': [new]})['results'][0]['code'] == 'USER_REVOKED'


def test_batch_contract():
    with closing(Store(':memory:')) as store:
        exercise_batch(store)


def test_served_select_count_does_not_grow_per_article():
    with closing(Store(':memory:')) as store:
        statements = []
        store.db.set_trace_callback(statements.append)
        stamp = iso(int(time.time() * 1000))
        store.intake_served({'records': [dict(request_id='r', impression_id=f'i-{i}', reader_id='u',
            article_id='a', position=i+1, served_at=stamp) for i in range(100)]})
        assert len([s for s in statements if s.startswith('SELECT')]) == 4


def test_rejected_middle_row_preserves_valid_rows_and_atomic_keeps_prior_data():
    with closing(Store(':memory:')) as store:
        stamp = iso(int(time.time() * 1000))
        first = dict(request_id='r', impression_id='first', reader_id='reader',
                     article_id='a', position=1, served_at=stamp)
        last = {**first, 'impression_id': 'last', 'position': 2}
        conflict = {**first, 'article_id': 'different'}
        result = store.intake_served({'records': [first, conflict, last]})['results']
        assert [row['status'] for row in result] == ['accepted', 'rejected', 'accepted']
        assert result[1]['code'] == 'IMPRESSION_ID_CONFLICT'
        assert store.counts()['served'] == 2
        pending = {**first, 'impression_id': 'pending'}
        with pytest.raises(InputError):
            store.intake_served({'records': [pending, pending, conflict]}, atomic=True)
        assert store.get('served_records', 'impression_id', 'pending') is None
        assert store.counts()['served'] == 2
        assert store.intake_served({'records': [first, last]})['results'] == [
            {'impression_id': 'first', 'status': 'duplicate'},
            {'impression_id': 'last', 'status': 'duplicate'}]
