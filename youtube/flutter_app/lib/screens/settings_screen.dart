import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/lanflix_api.dart';
import '../api/discovery_service.dart';
import '../providers/app_providers.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  late final TextEditingController _urlCtrl;
  final FocusNode _urlFocus = FocusNode();
  final FocusNode _federatedFocus = FocusNode();
  final FocusNode _saveFocus = FocusNode();
  final FocusNode _discoverFocus = FocusNode();
  bool _isDiscovering = false;

  @override
  void initState() {
    super.initState();
    final s = ref.read(settingsNotifierProvider);
    _urlCtrl = TextEditingController(text: s.apiBase);
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _urlFocus.dispose();
    _federatedFocus.dispose();
    _saveFocus.dispose();
    _discoverFocus.dispose();
    super.dispose();
  }

  Future<void> _discover() async {
    setState(() => _isDiscovering = true);
    try {
      final nodes = await DiscoveryService().discoverNodes().timeout(
            const Duration(seconds: 5),
            onTimeout: () => [],
          );
      if (nodes.isNotEmpty && mounted) {
        _urlCtrl.text = nodes.first;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Encontrado: ${nodes.first}')),
        );
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No se encontraron nodos')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _isDiscovering = false);
    }
  }


  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsNotifierProvider);
    final viewerAsync = ref.watch(viewerKeyProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Ajustes'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _urlCtrl,
            focusNode: _urlFocus,
            decoration: const InputDecoration(
              labelText: 'URL base del nodo',
              hintText: 'http://10.0.2.2:8080',
              border: OutlineInputBorder(),
            ),
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.next,
            autocorrect: false,
            onSubmitted: (_) {
              FocusScope.of(context).requestFocus(_discoverFocus);
            },
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            focusNode: _discoverFocus,
            onPressed: _isDiscovering ? null : _discover,
            icon: _isDiscovering
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.search),
            label: Text(_isDiscovering ? 'Buscando...' : 'Autodescubrimiento (mDNS)'),
          ),
          const SizedBox(height: 16),
          SwitchListTile(
            focusNode: _federatedFocus,
            title: const Text('Listado federado'),
            subtitle: const Text('Incluir vídeos de otros nodos enlazados'),
            value: settings.federated,
            onChanged: (v) {
              ref.read(settingsNotifierProvider.notifier).setFederated(v);
              // Mantener el foco aquí tras el rebuild
              _federatedFocus.requestFocus();
            },
          ),
          const SizedBox(height: 16),
          FilledButton(
            focusNode: _saveFocus,
            onPressed: () async {
              await ref
                  .read(settingsNotifierProvider.notifier)
                  .setApiBase(_urlCtrl.text);
              if (context.mounted) {
                ref.invalidate(videosProvider);
                ref.invalidate(seriesProvider);
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Guardado')),
                );
              }
            },
            child: const Text('Guardar'),
          ),
          const SizedBox(height: 24),
          const Text(
            'Clave de visor (anónima)',
            style: TextStyle(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          viewerAsync.when(
            data: (k) => SelectableText(k),
            loading: () => const CircularProgressIndicator(),
            error: (e, _) => Text('$e'),
          ),
        ],
      ),
    );
  }
}
