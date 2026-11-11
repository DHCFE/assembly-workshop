"""Convert each supported AI runner's response to the same checked recipe."""
import base64
import json
import mimetypes
import os
import shutil
import subprocess
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from photo_recipe import SCHEMA, make_prompt, validate
from scene_io import read_json, write_json

NAMES = ('off', 'codex', 'claude-code', 'openai-compatible')


def executable(provider):
    env, name = ('WORKSHOP_CODEX', 'codex') if provider == 'codex' else ('WORKSHOP_CLAUDE', 'claude')
    return os.environ.get(env) or shutil.which(name)


def available(provider):
    if provider in ('codex', 'claude-code'):
        return bool(executable(provider))
    return provider == 'openai-compatible' and bool(os.getenv('WORKSHOP_AI_BASE_URL') and os.getenv('WORKSHOP_AI_MODEL'))


def cli_recipe(provider, folder, image, prompt):
    program = executable(provider)
    if provider == 'codex':
        schema = folder / 'ai-schema.json'
        draft = folder / 'recipe-response.json'
        write_json(schema, SCHEMA)
        draft.unlink(missing_ok=True)
        command = [program, 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
                   '--sandbox', 'read-only', '-C', str(folder), '--output-schema', str(schema),
                   '-o', str(draft), '--image', str(image), '--', prompt]
    else:
        command = [program, '-p', '--output-format', 'json', '--json-schema', json.dumps(SCHEMA),
                   '--allowedTools', 'Read', '--no-session-persistence', '--max-turns', '5',
                   f'先读取工作目录中的图片文件 {image.name}，然后完成这个任务。\n{prompt}']
    result = subprocess.run(command, cwd=folder, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=240)
    if result.returncode:
        raise RuntimeError(f'{provider} 未能生成场景，请检查它的登录状态和可用额度。')
    if provider == 'codex':
        return read_json(draft)
    response = json.loads(result.stdout)
    if response.get('is_error'):
        raise RuntimeError('Claude Code 未能生成场景，请检查模型和图片读取权限。')
    return response.get('structured_output')


def api_recipe(image, prompt):
    base = os.environ['WORKSHOP_AI_BASE_URL'].rstrip('/')
    key = os.getenv('WORKSHOP_AI_API_KEY')
    content_type = mimetypes.guess_type(image.name)[0]
    encoded = base64.b64encode(image.read_bytes()).decode('ascii')
    json_format = {'type': 'json_object'}
    if os.getenv('WORKSHOP_AI_JSON_MODE', 'schema') == 'schema':
        json_format = {'type': 'json_schema', 'json_schema': {'name': 'assembly_recipe', 'strict': True, 'schema': SCHEMA}}
    payload = {'model': os.environ['WORKSHOP_AI_MODEL'], 'response_format': json_format, 'messages': [
        {'role': 'user', 'content': [{'type': 'text', 'text': prompt},
         {'type': 'image_url', 'image_url': {'url': f'data:{content_type};base64,{encoded}'}}]},
    ]}
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    request = Request(base + '/chat/completions', json.dumps(payload).encode(), headers)
    try:
        with urlopen(request, timeout=180) as response:
            result = json.loads(response.read(1_048_576))
    except HTTPError as error:
        raise RuntimeError(f'生成服务返回 HTTP {error.code}，请检查模型配置与额度。') from error
    except URLError as error:
        raise RuntimeError('生成服务连接失败，请检查服务地址。') from error
    return json.loads(result['choices'][0]['message']['content'])


def generate_recipe(provider, folder, image, phase, previous=None):
    target = folder / f'phase-{phase}-ai.json'
    if target.is_file():
        return validate(read_json(target))
    prompt = make_prompt(phase, previous)
    for attempt in range(2):
        try:
            raw = api_recipe(image, prompt) if provider == 'openai-compatible' else cli_recipe(provider, folder, image, prompt)
            result = validate(raw)
        except (ValueError, KeyError, TypeError, AttributeError, FileNotFoundError):
            if attempt:
                raise ValueError('AI 返回的构件未通过配方校验。') from None
            prompt += '。重新检查 JSON，坐标和尺寸都必须是三个有限数字，构件形状、动作与手势必须匹配。'
        else:
            write_json(target, result)
            return result
