"""Fresh, structured songwriting briefs from the configured DeepSeek account."""
import json,os,secrets,subprocess,tempfile,urllib.error,urllib.request
from pathlib import Path

THEMES=('错过末班车后的意外相遇','旧物里找到新的出发理由','平常的一天被一个细节照亮','离开熟悉的城市重新开始','和过去的自己温柔告别','雨停以后决定赴约','朋友之间没有说出口的感谢','忙碌生活里偷来的一小段自由','重逢时已经改变的两个人','把遗憾变成向前走的勇气')
STYLES=('中文流行','原声民谣','松弛 R&B','轻快流行摇滚','温暖 City Pop','叙事蓝调','轻爵士流行')

def text(value,label,limit):
    if not isinstance(value,str) or not 1<=len(value.strip())<=limit:raise ValueError('灵感中的'+label+'格式不完整，请再试一次')
    return value.strip().rstrip('。；; ')

def compile_idea(data,instrumental):
    if not isinstance(data,dict):raise ValueError('灵感回复格式不完整，请再试一次')
    title=text(data.get('title'),'标题',50);theme=text(data.get('theme'),'主题',200)
    genre=text(data.get('genre'),'风格',80);mood=text(data.get('mood'),'情绪',100)
    instruments=data.get('instruments')
    if not isinstance(instruments,list) or not 2<=len(instruments)<=6:raise ValueError('灵感需包含2至4种互相搭配的配器')
    instruments=[text(v,'配器',35) for v in instruments[:4]]
    development=text(data.get('development'),'段落发展',300)
    idea=f'一首{genre}的'+('纯音乐' if instrumental else '中文歌曲')+f'，{theme}。情绪：{mood}。配器：'+'、'.join(instruments)+f'。{development}。'
    idea+=('纯器乐，不含人声、演唱或哼唱。' if instrumental else text(data.get('voice'),'人声方向',120)+'，中文吐字自然清楚。')
    return {'idea':idea,'title':title,'instrumental':instrumental,'source':'deepseek'}

def complete(payload,key):
    url='https://api.deepseek.com/chat/completions'
    raw=json.dumps(payload,ensure_ascii=False).encode()
    req=urllib.request.Request(url,data=raw,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req,timeout=30) as response:return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError('DeepSeek 灵感服务暂不可用，请稍后重试') from None
    except (urllib.error.URLError,TimeoutError,OSError):
        # Retry this small, non-music text call only. No local canned fallback.
        with tempfile.TemporaryDirectory(prefix='osmanthus-inspiration-') as folder:
            path=Path(folder)/'request.json';path.write_bytes(raw)
            try:
                result=subprocess.run(['curl','--noproxy','*','--silent','--show-error','--fail','--connect-timeout','8','--max-time','35','--header','@-','--header','Content-Type: application/json','--data-binary','@'+str(path),url],input=('Authorization: Bearer '+key+'\n').encode(),capture_output=True,timeout=40)
            except subprocess.TimeoutExpired:raise RuntimeError('DeepSeek 灵感连接超时，请稍后重试') from None
        if result.returncode:raise RuntimeError('DeepSeek 灵感连接失败，请再试一次')
        return json.loads(result.stdout)

def generate(body):
    instrumental=body.get('instrumental',False);context=body.get('context','')
    if not isinstance(instrumental,bool) or not isinstance(context,str) or len(context)>2000:raise ValueError('灵感请求格式无效')
    key=os.environ.get('DEEPSEEK_API_KEY','')
    if not key:raise ValueError('尚未配置 DeepSeek 灵感服务')
    payload={'model':os.environ.get('DEEPSEEK_MODEL','deepseek-flash'),'thinking':{'type':'disabled'},'response_format':{'type':'json_object'},'temperature':1.05,'max_tokens':1200,
        'messages':[{'role':'system','content':'你是原创音乐创意和编曲策划。生成一条具体、可执行、有记忆点的歌曲创作想法，供用户编辑后写词和生成音乐。只输出JSON：title短标题、theme包含具体场景和情绪转折的主题（60字以内）、genre一个清楚的主风格、mood、instruments为2至4种互补配器的数组、development在100字内说明主旋律记忆点与段落发展（主歌留白、副歌提升、桥段或尾奏合理收束，避免所有段落同样堆叠）、voice自然演唱方向（纯音乐时为空）。有歌词时考虑中文短句与可唱性；器乐时用乐器动机代替歌词。避免空泛形容词堆砌、明星姓名、现成歌曲和所有乐器同时铺满。优先用户已有意图；内部比较后只给出一条完整、自然的方案。'},
            {'role':'user','content':json.dumps({'模式':'纯音乐' if instrumental else '中文演唱歌曲','用户已有想法':context.strip(),'随机主题启发':secrets.choice(THEMES),'可选风格启发':secrets.choice(STYLES),'本次变化标识':secrets.token_hex(4)},ensure_ascii=False)}]}
    try:
        response=complete(payload,key);data=json.loads(response['choices'][0]['message']['content']);return compile_idea(data,instrumental)
    except (ValueError,KeyError,IndexError,TypeError):raise ValueError('DeepSeek 灵感回复不完整，请再试一次') from None
