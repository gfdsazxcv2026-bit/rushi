import test from 'node:test';
import assert from 'node:assert/strict';
import {hasLaterSourceNarration} from '../server/role-integrity.mjs';
import {renderRoleReply} from '../server/role-output.mjs';

const scene={identity:'武成侯',year:-221};
const context={characterStatus:{condition:'normal'},sources:[]};
const render=(reply,action='')=>renderRoleReply(JSON.stringify({frame:{identity:scene.identity,year:scene.year,condition:'normal'},action,reply,references:[]}),{scene,context});

test('known autobiographical later-book/source narration is rejected for retry',()=>{
  for(const text of [
    '至于为何坚壁不战，这既是史书的记载，也是我的判断。',
    '记载中说我“坚壁而守之，不肯战”，这是事实；但我个人的判断是等待战机。',
    '《史记》记载了我的征楚之役。',
    '我读过《史记》，其中说得清楚。',
    '司马迁写过老夫为何求田。',
    '《资治通鉴》对此有明文。',
    '我没读过《史记》，但是司马迁写道老夫求田。',
    '按你给的《史记》，老夫早已读过它。',
  ]) {
    assert.equal(hasLaterSourceNarration(text,scene),true,text);
    assert.throws(()=>render(text),error=>error.code==='MODEL_ROLE_NARRATION' && error.retryable===true,text);
  }
});

test('ordinary old history, wishes, denial, visitor-supplied material and creative reactions remain available',()=>{
  for(const text of [
    '周室衰微，诸侯争强，老夫只说自己所见。',
    '周史记载先王之事，足供借鉴。',
    '老夫所读的史书讲的是周王之事。',
    '我据史书所载，谈谈周室东迁。',
    '老夫不识司马迁，也不知《史记》是何物。',
    '听你方才所言，《史记》是后世人的记述。',
    '你提供的记载中说我坚壁不战，确与亲历相符。',
    '司马迁是谁？',
    '若有后世，愿百姓少经战乱。',
    '老夫未曾读过你说的《史记》。',
    '《史记》？老夫不知这是何书。',
    '按你给的《史记》，这段写的是老夫求田。我只谈眼前用兵的判断。',
    '你说司马迁如此评论，老夫愿听你的解释。',
    '假设你带来《汉书》，老夫可以先听其中的说法。',
    '老夫当时担心兵众难制，也须思量君上疑虑。',
  ]) assert.doesNotThrow(()=>render(text),text);
  assert.doesNotThrow(()=>render('近前些，眼下还有事要交代。','声音微弱，停顿片刻。'));
  assert.equal(hasLaterSourceNarration('《史记》记载了秦军征楚。',{year:200}),false);
});

test('an attributed first sentence cannot authorize a separate claim or action of reading future history',()=>{
  for(const [reply,action] of [
    ['你给的书，老夫先听你说。老夫曾读过《史记》。',''],
    ['老夫只谈当下。','翻开案上的《史记》，指着自身传记。'],
  ]) assert.throws(()=>render(reply,action),error=>error.code==='MODEL_ROLE_NARRATION');
});

test('explicitly supplied future material can be continued without treating RAG source titles as autobiographical knowledge',()=>{
  const conditions=[{text:'访客带来《史记》，并把王翦求田的片段念给王翦听。'}];
  assert.equal(hasLaterSourceNarration('《史记》这一段，所说的求田之事老夫可以讲讲。',scene,{conditions}),false);
  assert.equal(hasLaterSourceNarration('老夫原本熟读《史记》。',scene,{conditions}),true);
  assert.equal(hasLaterSourceNarration('《史记》记载了老夫。',scene,{sources:[{title:'史记'}]}),true);
  assert.equal(hasLaterSourceNarration('《汉书》也记载了老夫。',scene,{conditions}),true);
  assert.equal(hasLaterSourceNarration('《史记》这一段，且听你细说。',scene,{knowledge:[{text:'我带来一本《史记》给你，里面有求田的记述。'}]}),false);
});
