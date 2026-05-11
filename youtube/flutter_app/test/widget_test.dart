import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lanflix_tv/app.dart';
import 'package:lanflix_tv/providers/app_providers.dart';
import 'package:lanflix_tv/settings/settings_repository.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('Muestra Lanflix', (WidgetTester tester) async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final repo = SettingsRepository(prefs);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          settingsRepositoryProvider.overrideWithValue(repo),
        ],
        child: const LanflixApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Lanflix'), findsOneWidget);
  });
}
