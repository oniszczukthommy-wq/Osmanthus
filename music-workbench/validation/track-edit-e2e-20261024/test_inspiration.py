import json,unittest
from unittest.mock import patch
import inspiration as m

DATA={'title':'雨后的第一班车','theme':'等车时遇见久别的朋友，从疲惫走向释然','genre':'轻快中文流行','mood':'温暖，带一点期待','instruments':['原声吉他','电钢琴','轻鼓组'],'development':'主歌留白，副歌旋律向上打开，桥段减薄后自然收尾','voice':'温暖自然的男声'}
class InspirationTests(unittest.TestCase):
 def test_brief_includes_concrete_theme_instruments_and_development(self):
  r=m.compile_idea(DATA,False);self.assertEqual(r['source'],'deepseek');self.assertIn(DATA['theme'],r['idea']);self.assertIn('桥段',r['idea']);self.assertIn('原声吉他',r['idea'])
 def test_instrumental_never_compiles_vocal_direction(self):
  r=m.compile_idea({**DATA,'voice':''},True);self.assertIn('不含人声',r['idea']);self.assertNotIn('男声',r['idea'])
 def test_incomplete_reply_is_rejected_without_canned_fallback(self):
  with self.assertRaises(ValueError):m.compile_idea({**DATA,'instruments':[]},False)
 def test_real_generation_path_calls_configured_model_and_preserves_context(self):
  with patch.dict(m.os.environ,{'DEEPSEEK_API_KEY':'test-only','DEEPSEEK_MODEL':'deepseek-flash'}),patch.object(m,'complete',return_value={'choices':[{'message':{'content':json.dumps(DATA)}}]}) as call:
   r=m.generate({'context':'雨后的清晨','instrumental':False})
  self.assertEqual(call.call_count,1);self.assertIn('雨后的清晨',call.call_args.args[0]['messages'][1]['content']);self.assertEqual(r['title'],DATA['title'])
 def test_missing_key_does_not_return_a_local_idea(self):
  with patch.dict(m.os.environ,{'DEEPSEEK_API_KEY':''}),patch.object(m,'complete') as call,self.assertRaises(ValueError):m.generate({})
  call.assert_not_called()
 def test_invalid_mode_is_rejected_before_model_request(self):
  with self.assertRaises(ValueError):m.generate({'instrumental':'yes'})
if __name__=='__main__':unittest.main()
