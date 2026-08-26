#!/usr/bin/env python3
"""
Log in to AO3 once and keep the session cookie.

The password is read from the terminal and used immediately; it is never
printed, never written to disk, and never passed as an argument (argv is
visible to every process on the device). What persists is the session cookie,
which expires on its own and dies the moment you log out of AO3 — so if it
does leak, the blast radius is bounded in a way a password's is not.

Usage:  python3 tools/ao3-login.py            # log in, save the cookie
        python3 tools/ao3-login.py --check    # is the saved cookie still good?
"""
import getpass
import http.cookiejar
import os
import re
import sys
import urllib.parse
import urllib.request

BASE = "https://archiveofourown.org"
UA = "ArchiveReader/0.1 (personal offline reader for my own AO3 account)"
JAR_PATH = os.path.expanduser("~/.config/archive-reader/cookies.txt")


def opener_for(jar):
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def get(op, url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with op.open(req, timeout=30) as r:
        return r.status, r.read().decode("utf-8", "replace")


def token_from(html):
    """The page carries two login forms (header and main); either token works,
    but it must be paired with the cookies from this same response."""
    m = re.search(r'name="authenticity_token"[^>]*value="([^"]+)"', html)
    if not m:
        m = re.search(r'value="([^"]+)"[^>]*name="authenticity_token"', html)
    return m.group(1) if m else None


def logged_in_as(html):
    m = re.search(r'href="/users/([^/"]+)"[^>]*>\s*My Dashboard', html)
    return m.group(1) if m else None


def save(jar):
    os.makedirs(os.path.dirname(JAR_PATH), exist_ok=True)
    # create with 0600 before anything is written, not after
    fd = os.open(JAR_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.close(fd)
    jar.save(JAR_PATH, ignore_discard=True, ignore_expires=True)
    os.chmod(JAR_PATH, 0o600)


def check():
    jar = http.cookiejar.MozillaCookieJar(JAR_PATH)
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except (OSError, http.cookiejar.LoadError):
        print("no saved session — run without --check to log in")
        return 1
    status, html = get(opener_for(jar), BASE + "/")
    who = logged_in_as(html)
    if who:
        print(f"session is valid — logged in as {who}")
        return 0
    print("session is not valid any more — log in again")
    return 1


def login():
    jar = http.cookiejar.MozillaCookieJar(JAR_PATH)
    op = opener_for(jar)

    status, html = get(op, BASE + "/users/login")
    if status != 200:
        print(f"could not load the login page (status {status})", file=sys.stderr)
        return 1
    token = token_from(html)
    if not token:
        print("no authenticity token on the login page — AO3's form has changed",
              file=sys.stderr)
        return 1

    user = input("AO3 username: ").strip()
    password = getpass.getpass("AO3 password (not shown, not saved): ")

    body = urllib.parse.urlencode({
        "authenticity_token": token,
        "user[login]": user,
        "user[password]": password,
        "user[remember_me]": "1",
        "commit": "Log In",
    }).encode()
    del password  # no reason for it to outlive the request

    req = urllib.request.Request(
        BASE + "/users/login", data=body,
        headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
                 "Referer": BASE + "/users/login"})
    with op.open(req, timeout=30) as r:
        page = r.read().decode("utf-8", "replace")

    who = logged_in_as(page)
    if not who:
        # AO3 re-renders the form with an error rather than returning a 4xx
        if re.search(r"password.{0,40}(incorrect|invalid)|user name or password", page, re.I):
            print("AO3 rejected that username/password", file=sys.stderr)
        else:
            print("login did not take — AO3 may be asking for something new "
                  "(check for a captcha by opening the site in a browser)", file=sys.stderr)
        return 1

    save(jar)
    print(f"logged in as {who}")
    print(f"session cookie saved to {JAR_PATH} (mode 600)")
    print("log out on AO3 to revoke it")
    return 0


if __name__ == "__main__":
    sys.exit(check() if "--check" in sys.argv else login())
