import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'downloads.dart';
import 'theme.dart';

/// Signing in on the archive's own page.
///
/// Not a username and password box. The archive has no sign-in endpoint for
/// other people's apps to call, and asking somebody to type their password
/// into a third-party app is the wrong shape even where it works — it teaches
/// the habit that phishing relies on, and it cannot answer a captcha, a
/// two-factor prompt or a Cloudflare challenge, all of which the archive
/// serves to a phone sooner or later.
///
/// So this opens their page, lets them sign in to it exactly as they would in
/// a browser, and then reads the session cookie out of the platform's own
/// cookie store. The password is between them and the archive and never
/// passes through this app at all.
class SignInScreen extends StatefulWidget {
  const SignInScreen({required this.downloads, super.key});

  final Downloads downloads;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  static final Uri _login = Uri.parse(
    'https://archiveofourown.org/users/login',
  );

  final CookieManager _cookies = CookieManager.instance();
  double _loaded = 0;
  bool _checking = false;
  String? _trouble;

  /// Has the archive started calling us somebody?
  ///
  /// Watched rather than waited for: there is no single page that means
  /// "signed in". The archive lands you back wherever you were, and a reader
  /// might wander for a while before it takes. So every page that finishes
  /// loading is asked whether it carries a dashboard link, which is the only
  /// honest sign there is a session behind it.
  Future<void> _look(InAppWebViewController web) async {
    if (_checking) return;
    final html = await web.getHtml();
    final who = core.signedInAs(html ?? '');
    if (who == null || !mounted) return;

    setState(() => _checking = true);
    try {
      /* Every cookie the archive set, Cloudflare's included. They were
         issued to this device's own webview, minutes ago, to the browser the
         client presents itself as — dropping them makes the next request
         look like a fresh unverified client. */
      final jar = <String, String>{
        for (final cookie in await _cookies.getCookies(url: WebUri('$_login')))
          cookie.name: '${cookie.value}',
      };
      await widget.downloads.adoptSession(jar, who);
      if (!mounted) return;
      Navigator.of(context).pop(who);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _checking = false;
        _trouble = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Sign in to the archive'),
        bottom: _loaded >= 1
            ? null
            : PreferredSize(
                preferredSize: const Size.fromHeight(2),
                child: LinearProgressIndicator(value: _loaded, minHeight: 2),
              ),
      ),
      body: Column(
        children: [
          Container(
            width: double.infinity,
            color: ground.sunken,
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
            child: Text(
              'This is the archive’s own page. Your password goes to them and '
              'never through this app; what is kept here afterwards is the '
              'session, which you can end by logging out on the site.',
              style: TextStyle(
                fontSize: 12.5,
                height: 1.45,
                color: ground.inkMute,
              ),
            ),
          ),
          if (_trouble != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                _trouble!,
                style: TextStyle(color: ground.accent, fontSize: 13),
              ),
            ),
          Expanded(
            child: InAppWebView(
              initialUrlRequest: URLRequest(url: WebUri('$_login')),
              initialSettings: InAppWebViewSettings(
                // a sign-in page that will not run scripts is a sign-in page
                // that cannot answer a challenge
                javaScriptEnabled: true,
                // the archive decides what a browser is; presenting as
                // something else here is asking to be challenged
                incognito: false,
                supportZoom: true,
              ),
              onProgressChanged: (_, progress) =>
                  setState(() => _loaded = progress / 100),
              onLoadStop: (web, _) => _look(web),
            ),
          ),
          if (_checking) const LinearProgressIndicator(minHeight: 2),
        ],
      ),
    );
  }
}
