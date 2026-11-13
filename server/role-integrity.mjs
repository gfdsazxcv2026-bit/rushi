// Bounded regression guard for known source-narration mistakes. Source excerpts
// are shown by the server, not attributed to a Qin character's own reading.
const LATER_WORKS = [
  {name:'史记', availableAfter:-91},
  {name:'汉书', availableAfter:82},
  {name:'资治通鉴', availableAfter:1084},
];
const ATTRIBUTED = /你(?:所)?(?:给|提供|带来|递来|展示|告诉|说)|(?:按|据|照着|依)你|听你.{0,8}(?:所言|说)|若按|假设|倘若/u;
const DENIED = /(?:未曾|不曾|没有|没|未|不可能|不能|并未|未能)(?:读过|读到|见过|见到|听过|听说过|看过|看见|知晓)|不识|未闻其名|不知.{0,12}(?:何书|何人|何物)|并非.{0,12}(?:所知|亲历)/u;

export function hasLaterSourceNarration(text, scene, context = {}) {
  for (const sentence of String(text).split(/[。！？；\n]/u)) {
    const laterWork = LATER_WORKS.some(work=>scene.year < work.availableAfter && new RegExp(`《${work.name}》|${work.name}(?!载)`,'u').test(sentence));
    const laterAuthor = scene.year < -145 && /司马迁/u.test(sentence);
    // Do not infer a future source merely from the word “史书”: characters
    // may discuss earlier chronicles. Keep the observed self-narration form.
    const selfAsSource = /(?:这|此|既).{0,8}是史书的(?:记载|记录).{0,12}(?:也|亦)是(?:寡人|朕|我|在下|老夫)的判断|记载(?:中|里)?(?:说|写|称)(?:道)?(?:寡人|朕|我|在下|老夫)/u.test(sentence);
    if (!(laterWork || laterAuthor || selfAsSource)) continue;
    if (/^\s*[“「]?《(?:史记|汉书|资治通鉴)》[”」]?\s*$/u.test(sentence)) continue;
    if (/^\s*(?:《(?:史记|汉书|资治通鉴)》|司马迁)(?:是(?:谁|何人|何物|什么)|为何人)[？?]?\s*$/u.test(sentence)) continue;
    const names=[...LATER_WORKS.filter(work=>sentence.includes(work.name)).map(work=>work.name),...(sentence.includes('司马迁')?['司马迁']:[])];
    const supplied=[context.question,...(context.conditions||[]).map(item=>item.text),...(context.knowledge||[]).map(item=>item.text)].filter(Boolean);
    const suppliedHere=names.length && names.every(name=>supplied.some(item=>String(item).includes(name) && /我(?:已经|已|曾)?(?:给|递|带|提供|交)|你(?:已经|已)?收到|访客(?:带|提供)|用户(?:提供|带来)/u.test(item)));
    if (suppliedHere && !/(?:早已|原本|本就).{0,6}(?:读过|看过|知道|熟读)/u.test(sentence)) continue;
    // A visitor can supply a future book, and characters can deny knowing it.
    // The attribution must be in this sentence; a mention elsewhere cannot
    // authorize a separate assertion of autobiographical future knowledge.
    if (ATTRIBUTED.test(sentence)) {
      const clauses=sentence.split(/[，,]/u);
      if (!clauses.some(clause=>!ATTRIBUTED.test(clause) && !DENIED.test(clause) && /(?:早已|原本|本就).{0,6}(?:读过|看过|知道|熟读)/u.test(clause))) continue;
    }
    if (DENIED.test(sentence) && !sentence.split(/[，,]|但是|然而|不过/u).some(clause=>!DENIED.test(clause) && /(?:已经|早已|曾经|确实|当然).{0,6}(?:读过|看过|知道|熟读)|(?:记载|写道|说过)/u.test(clause))) continue;
    return true;
  }
  return false;
}
