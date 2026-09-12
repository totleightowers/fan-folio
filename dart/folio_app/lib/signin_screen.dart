import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'downloads.dart';
import 'theme.dart';

/// Signing in to the archive.
///
/// The password is used to fill the archive's own sign-in form and is never
/// written down — not here, not in the library, not in a backup. What is kept
/// is the cookie the archive hands back, which the reader can revoke by
/// logging out on the site.
class SignInScreen extends StatefulWidget {
  const SignInScreen({required this.downloads, super.key});

  final Downloads downloads;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final TextEditingController _user = TextEditingController();
  final TextEditingController _password = TextEditingController();
  bool _hidden = true;
  bool _working = false;
  String? _trouble;

  @override
  void dispose() {
    _user.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    if (_user.text.trim().isEmpty || _password.text.isEmpty) {
      setState(() => _trouble = 'Both of those are needed.');
      return;
    }
    setState(() {
      _working = true;
      _trouble = null;
    });

    final navigator = Navigator.of(context);
    try {
      final who = await widget.downloads.signIn(
        _user.text.trim(),
        _password.text,
      );
      // no reason for it to outlive the request that used it
      _password.clear();
      navigator.pop(who);
    } on core.ArchiveError catch (e) {
      if (!mounted) return;
      setState(() {
        _working = false;
        _trouble = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _working = false;
        _trouble = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
        children: [
          Text(
            'Signing in lets the app fetch works that are locked to '
            'registered users, and read your own bookmarks.',
            style: TextStyle(fontSize: 14, height: 1.5, color: ground.inkMid),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _user,
            autofocus: true,
            autocorrect: false,
            enableSuggestions: false,
            textInputAction: TextInputAction.next,
            decoration: InputDecoration(
              labelText: 'Username or email',
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Radii.field),
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            obscureText: _hidden,
            autocorrect: false,
            enableSuggestions: false,
            textInputAction: TextInputAction.go,
            onSubmitted: (_) => _go(),
            decoration: InputDecoration(
              labelText: 'Password',
              errorText: _trouble,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Radii.field),
              ),
              suffixIcon: IconButton(
                icon: Icon(
                  _hidden
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                ),
                tooltip: _hidden ? 'Show' : 'Hide',
                onPressed: () => setState(() => _hidden = !_hidden),
              ),
            ),
          ),
          const SizedBox(height: 18),
          FilledButton(
            onPressed: _working ? null : _go,
            child: Text(_working ? 'Signing in…' : 'Sign in'),
          ),
          const SizedBox(height: 22),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: ground.sunken,
              borderRadius: BorderRadius.circular(Radii.card),
            ),
            child: Text(
              'This goes straight to the archive and nowhere else. Your '
              'password fills their own sign-in form and is not written down '
              '— not on this phone, not in the library, not in a backup. What '
              'is kept is the session they hand back, which you can revoke by '
              'logging out on the site.',
              style: TextStyle(
                fontSize: 12.5,
                height: 1.5,
                color: ground.inkMute,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
