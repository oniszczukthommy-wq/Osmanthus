"""Three deliberately limited first-version voices; archive remains internal."""
PRESETS=[
    {'id':'lyrical-male','name':'抒情男声','reference_voice_id':'226869000163476',
     'gender':'男声','description':'温暖、柔和，适合抒情流行与民谣',
     'generation_prompt':'温暖醇厚的抒情男声，普通话清楚自然，保留换气与力度起伏，避免机械修音和明显电音',
     'singing_validation':'one_prototype_song_user_accepted'},
    {'id':'clear-female','name':'清亮女声','reference_voice_id':'258950761001152',
     'gender':'女声','description':'清亮、有活力，适合清新流行',
     'generation_prompt':'清亮自然的女声，普通话吐字清晰，音色明亮而不过分尖细，保留轻重与换气，避免机械修音和明显电音',
     'singing_validation':'pending_short_sample'},
    {'id':'magnetic-male','name':'磁性男声','reference_voice_id':'258953065902272',
     'gender':'男声','description':'低沉、厚实，适合叙事流行与R&B',
     'generation_prompt':'低沉磁性的成年男声，普通话吐字清楚，厚实但不过度播音腔，演唱自然有起伏，避免机械修音和明显电音',
     'singing_validation':'pending_short_sample'},
]

def preset(identifier):
    value=next((p for p in PRESETS if p['id']==identifier),None)
    if value is None:raise ValueError('请选择三个预设音色之一')
    return dict(value)
