"""Validate scoped listening acceptance; keep full-score acceptance separate."""
from pathlib import Path
import hashlib,json,sys
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'track-edit-e2e-20261024'))
from scores import JOBS,valid_id

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def confirmed_pitches(data,config,context,notes,mapping):
    confirmed={}
    for record in config.get('note_listening_reviews',[]):
        if record.get('confirmed_by')!='user' or record.get('confirmation_scope')!='listed_target_pitches_only':raise ValueError('听辨确认范围不明确')
        identifier=record['source_score_job_id']
        if not valid_id(identifier):raise ValueError('听辨来源任务无效')
        path=JOBS/identifier/'score.json'
        if digest(path)!=record['score_json_sha256']:raise ValueError('听辨来源谱面已改变')
        source=json.loads(path.read_text())
        if any(source.get(k)!=context[k] for k in ('project_id','source_sha256','vocal_sha256','lyrics_sha256','basis')):raise ValueError('听辨确认与当前歌曲不匹配')
        assets={}
        for kind in ('manifest','audio'):
            asset=record[kind];name=asset['file']
            if Path(name).name!=name or digest(data/name)!=asset['sha256']:raise ValueError('听辨参考文件校验失败')
            assets[kind]=data/name
        manifest=json.loads(assets['manifest'].read_text())
        if manifest['source_score_job']!=identifier or manifest['score_json_sha256']!=record['score_json_sha256'] or manifest['audio_sha256']!=digest(assets['audio']) or manifest['source_vocal_sha256']!=context['vocal_sha256']:raise ValueError('听辨样例与参考谱不一致')
        orders=record['accepted_item_orders']
        if len(set(orders))!=len(orders):raise ValueError('听辨样例编号重复')
        for order in orders:
            items=[item for item in manifest['items'] if item['order']==order]
            if len(items)!=1:raise ValueError('未找到确认的听辨样例')
            item=items[0];targets=[n for n in source['notes'] if n['id']==item['note_id']]
            if len(targets)!=1:raise ValueError('听辨音符已改变')
            target=targets[0]
            if target['midi']!=item['current_midi'] or target['lyric']!=item['target_character']:raise ValueError('确认音高与试听清单不一致')
            matches=[i for i,n in enumerate(notes) if mapping.get(i,{}).get('index')==target['lyric_index'] and n['midi']==target['midi'] and abs(n['start_seconds']-target['start_seconds'])<1e-6 and abs(n['end_seconds']-target['end_seconds'])<1e-6]
            if len(matches)!=1:raise ValueError('已确认音符与当前分析不一致，请重新听辨')
            confirmed[matches[0]]={'review_id':record['id'],'source_score_job_id':identifier,'item_order':order,'lyric_index':target['lyric_index'],'lyric':target['lyric'],'midi':target['midi'],'source_range_seconds':[target['start_seconds'],target['end_seconds']],'confirmation_scope':'listed_target_pitch_only','rhythm_accepted':False,'whole_score_accuracy_accepted':False}
    return confirmed
