#!/usr/bin/env python3
"""Read Google Maps location sharing for one account and print it as JSON.

Shelled out to by sources/mapsSharing/index.js. Not meant to be run by hand, but you can:

    .venv/bin/python fetch.py --cookies /path/to/cookies.txt --email you@gmail.com

stdout: {"me": Person|null, "contacts": [Person, ...]}  on success
        {"error": "<code>", "message": "..."}            on failure (exit code != 0)

Person: {id, fullName, nickname, pictureUrl, lat, lng, acc, timestamp (ms), at (ISO), address,
         countryCode, battery, charging}

Exit codes: 0 ok · 2 cookies rejected or unparseable · 3 locationsharinglib missing · 4 Google
answered with something we could not parse.
"""
import argparse
import json
import logging
import sys
from datetime import datetime, timezone


def person_dict(p):
    ts = p.timestamp
    try:
        ts = int(ts)
    except (TypeError, ValueError):
        ts = None
    at = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat().replace('+00:00', 'Z') if ts else None
    return {
        'id': p.id,
        'fullName': p.full_name,
        'nickname': p.nickname,
        'pictureUrl': p.picture_url,
        'lat': p.latitude,
        'lng': p.longitude,
        'acc': p.accuracy,
        'timestamp': ts,
        'at': at,
        'address': p.address,
        'countryCode': p.country_code,
        'battery': p.battery_level,
        'charging': p.charging,
    }


def fail(code, error, message):
    json.dump({'error': error, 'message': str(message)[:800]}, sys.stdout)
    sys.stdout.write('\n')
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cookies', required=True, help='Netscape cookies.txt exported for google.com')
    ap.add_argument('--email', default='unknown@gmail.com', help='the Google account the cookies belong to')
    args = ap.parse_args()
    logging.disable(logging.CRITICAL)   # the lib logs chatty warnings; we report through JSON instead

    try:
        from locationsharinglib import Service
        from locationsharinglib.locationsharinglibexceptions import InvalidCookieFile, InvalidCookies, InvalidData
    except ImportError as e:
        fail(3, 'missing_dependency', f'locationsharinglib not importable ({e}). Run sources/mapsSharing/setup.sh')

    try:
        service = Service(cookies_file=args.cookies, authenticating_account=args.email)
        contacts = [person_dict(p) for p in service.get_shared_people()]
        me = service.get_authenticated_person()
    except (InvalidCookies, InvalidCookieFile) as e:
        fail(2, 'invalid_cookies', e)
    except InvalidData as e:
        fail(4, 'invalid_data', e)
    except Exception as e:  # network errors etc; keep the caller's log readable
        fail(4, 'fetch_failed', f'{type(e).__name__}: {e}')

    json.dump({'me': person_dict(me) if me else None, 'contacts': contacts}, sys.stdout)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
