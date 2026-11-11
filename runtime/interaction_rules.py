"""Validate the input strategy independently of the geometry it drives."""

import json
from pathlib import Path


INTERACTIONS = json.loads(Path(__file__).with_name('interactions.json').read_text(encoding='utf-8'))
PLACEMENT = json.loads(Path(__file__).with_name('placement.json').read_text(encoding='utf-8'))


def resolve_interaction(operation, requested='auto'):
    options = INTERACTIONS[operation]
    if requested == 'auto':
        return options[0]
    if requested not in options:
        raise ValueError(f'{operation} 不支持手势 {requested!r}，可选 {", ".join(options)}')
    return requested


def resolve_placement(operation, requested='auto', revisit=False):
    tangible = not revisit and operation in PLACEMENT['trayOperations']
    if requested == 'auto':
        return 'tray' if tangible else 'in_place'
    if requested == 'in_place' or (requested == 'tray' and tangible):
        return requested
    raise ValueError(f'{operation} 不支持摆放方式 {requested!r}')
