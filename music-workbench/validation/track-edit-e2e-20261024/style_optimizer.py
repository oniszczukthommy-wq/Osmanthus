"""Optimize a music style description without sending lyrics to the provider."""
import json
import os

from inspiration import complete
from paid_usage import PaidUsageError


def optimize(body):
    if not isinstance(body, dict):
        raise ValueError('风格优化请求格式无效')
    style = body.get('style')
    instrumental = body.get('instrumental')
    if not isinstance(style, str) or not 1 <= len(style.strip()) <= 1000:
        raise ValueError('风格描述需为 1 至 1000 字')
    if not isinstance(instrumental, bool):
        raise ValueError('纯音乐选项格式无效')
    key = os.environ.get('DEEPSEEK_API_KEY', '')
    if not key:
        raise ValueError('风格优化服务尚未配置，可以继续使用原风格描述')
    request = {
        'model': os.environ.get('DEEPSEEK_MODEL', 'deepseek-flash'),
        'thinking': {'type': 'disabled'},
        'response_format': {'type': 'json_object'},
        'temperature': 0.4,
        'max_tokens': 1800,
        'messages': [
            {'role': 'system', 'content': (
                '你是音乐风格与编曲描述编辑。将用户提供的风格描述优化为可用于音乐生成的具体提示，'
                '保留原有风格、要求和限制，适度整理情绪、速度、配器、律动和编曲层次，不添加具体歌手、'
                '现成歌曲或歌词，不假装听过参考音频。纯音乐模式不能要求人声、演唱、说唱或哼唱。'
                '只返回 JSON 对象，包含一个 style 字段，值是 1000 字以内、可直接编辑的风格描述。'
            )},
            {'role': 'user', 'content': json.dumps({
                '风格描述': style.strip(), '纯音乐': instrumental,
            }, ensure_ascii=False)},
        ],
    }
    try:
        response = complete(request, key)
        result = json.loads(response['choices'][0]['message']['content'])
        optimized = result['style']
        if not isinstance(optimized, str) or not 1 <= len(optimized.strip()) <= 1000:
            raise ValueError('invalid style response')
        return {'style': optimized.strip()}
    except PaidUsageError:
        raise
    except (RuntimeError, ValueError, KeyError, IndexError, TypeError, UnicodeError):
        raise RuntimeError('风格优化暂时不可用，可以继续使用原风格描述') from None
