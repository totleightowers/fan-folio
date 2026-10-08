import 'package:flutter/material.dart';

/// Destinations available without backing out through the reading route stack.
enum AppDestination {
  home('Home', Icons.home_outlined),
  library('Library', Icons.menu_book_outlined),
  downloads('Downloads', Icons.download_outlined),
  you('You', Icons.person_outline),
  search('Search', Icons.search),
  settings('Settings', Icons.settings_outlined);

  const AppDestination(this.label, this.icon);

  final String label;
  final IconData icon;
}
