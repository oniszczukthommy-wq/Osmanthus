import json
import unittest
from unittest.mock import patch

import style_optimizer as target
from paid_usage import PaidUsageError


class StyleOptimizerTests(unittest.TestCase):
    def response(self, value):
        return {'choices': [{'message': {'content': json.dumps({'style': value}, ensure_ascii=False)}}]}

    def test_uses_style_and_instrumental_only_and_preserves_constraints(self):
        with patch.dict(target.os.environ, {'DEEPSEEK_API_KEY': 'test-only', 'DEEPSEEK_MODEL': 'test-model'}), \
             patch.object(target, 'complete', return_value=self.response('慢速民谣，只用木吉他')) as call:
            result = target.optimize({'style': '民谣，只用木吉他', 'instrumental': True, 'lyrics': '不得发送的测试歌词'})
        self.assertEqual(result, {'style': '慢速民谣，只用木吉他'})
        request, _ = call.call_args.args
        self.assertEqual(request['model'], 'test-model')
        self.assertEqual(json.loads(request['messages'][1]['content']), {'风格描述': '民谣，只用木吉他', '纯音乐': True})
        self.assertNotIn('不得发送的测试歌词', json.dumps(request, ensure_ascii=False))
        self.assertIn('不能要求人声', request['messages'][0]['content'])

    def test_rejects_invalid_input_before_provider_call(self):
        for body in ({'style': '', 'instrumental': False}, {'style': 'x' * 1001, 'instrumental': False},
                     {'style': '抒情', 'instrumental': 'true'}, {'style': '抒情'}):
            with self.subTest(body=body), patch.object(target, 'complete') as call:
                with self.assertRaises(ValueError): target.optimize(body)
                call.assert_not_called()

    def test_missing_key_and_invalid_provider_output_do_not_fake_success(self):
        with patch.dict(target.os.environ, {'DEEPSEEK_API_KEY': ''}), patch.object(target, 'complete') as call:
            with self.assertRaisesRegex(ValueError, '原风格描述'): target.optimize({'style': '流行', 'instrumental': False})
            call.assert_not_called()
        for result in ({}, self.response(''), self.response('长' * 1001), {'choices': [{'message': {'content': 'bad json'}}]}):
            with self.subTest(result=result), patch.dict(target.os.environ, {'DEEPSEEK_API_KEY': 'test-only'}), \
                 patch.object(target, 'complete', return_value=result):
                with self.assertRaisesRegex(RuntimeError, '原风格描述'): target.optimize({'style': '流行', 'instrumental': False})

    def test_provider_failure_is_sanitized_and_paid_limit_preserved(self):
        with patch.dict(target.os.environ, {'DEEPSEEK_API_KEY': 'test-only'}), \
             patch.object(target, 'complete', side_effect=RuntimeError('sensitive provider error')):
            with self.assertRaisesRegex(RuntimeError, '风格优化暂时不可用') as error:
                target.optimize({'style': '流行', 'instrumental': False})
            self.assertNotIn('sensitive', str(error.exception))
        with patch.dict(target.os.environ, {'DEEPSEEK_API_KEY': 'test-only'}), \
             patch.object(target, 'complete', side_effect=PaidUsageError('调用额度已用完')):
            with self.assertRaises(PaidUsageError): target.optimize({'style': '流行', 'instrumental': False})


if __name__ == '__main__': unittest.main()
