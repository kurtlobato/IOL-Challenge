import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
  List<String> _foundNodes = [];

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
    setState(() {
      _isDiscovering = true;
      _foundNodes = [];
    });
    try {
      final nodes = await DiscoveryService().discoverNodes().timeout(
            const Duration(seconds: 8),
            onTimeout: () => [],
          );
      if (mounted) {
        setState(() => _foundNodes = nodes);
        if (nodes.isNotEmpty) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Se encontraron ${nodes.length} nodos')),
          );
        }
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

  Future<void> _deepScan() async {
    setState(() {
      _isDiscovering = true;
      _foundNodes = [];
    });
    
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Iniciando escaneo profundo... esto puede tardar.')),
    );

    try {
      await for (final node in DiscoveryService().deepScanNodes()) {
        if (!mounted) break;
        if (!_foundNodes.contains(node)) {
          setState(() {
            _foundNodes.add(node);
          });
        }
      }
    } catch (e) {
      debugPrint('Deep scan error: $e');
    } finally {
      if (mounted) {
        setState(() => _isDiscovering = false);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Escaneo finalizado')),
        );
      }
    }
  }

  void _addChar(String char) {
    final text = _urlCtrl.text;
    final selection = _urlCtrl.selection;
    final newText = text.replaceRange(
      selection.start == -1 ? text.length : selection.start,
      selection.end == -1 ? text.length : selection.end,
      char,
    );
    _urlCtrl.text = newText;
    _urlCtrl.selection = TextSelection.collapsed(offset: selection.start + char.length);
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(settingsNotifierProvider);
    final viewerAsync = ref.watch(viewerKeyProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Ajustes de Conexión')),
      body: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Left Side: Main Settings
          Expanded(
            flex: 3,
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                const Text(
                  'Configuración del Nodo',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: Colors.white70),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _urlCtrl,
                  focusNode: _urlFocus,
                  decoration: InputDecoration(
                    labelText: 'URL del Servidor (Backend)',
                    hintText: 'http://192.168.1.15:8080',
                    filled: true,
                    fillColor: Colors.white.withOpacity(0.05),
                    border: const OutlineInputBorder(),
                    prefixIcon: const Icon(Icons.lan),
                  ),
                  style: const TextStyle(fontSize: 18),
                ),
                const SizedBox(height: 12),
                
                // IP Helper for TV
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _QuickCharButton(label: 'http://', onTap: () => _addChar('http://')),
                    _QuickCharButton(label: '192.168.', onTap: () => _addChar('192.168.')),
                    _QuickCharButton(label: '.', onTap: () => _addChar('.')),
                    _QuickCharButton(label: ':8080', onTap: () => _addChar(':8080')),
                    _QuickCharButton(
                      label: 'Borrar', 
                      icon: Icons.backspace_outlined,
                      onTap: () {
                        if (_urlCtrl.text.isNotEmpty) {
                          _urlCtrl.text = _urlCtrl.text.substring(0, _urlCtrl.text.length - 1);
                        }
                      },
                    ),
                  ],
                ),
                
                const SizedBox(height: 32),
                const Text('Opciones', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white54)),
                SwitchListTile(
                  focusNode: _federatedFocus,
                  title: const Text('Modo Federado'),
                  subtitle: const Text('Buscar contenido en otros PCs de la red'),
                  value: settings.federated,
                  onChanged: (v) {
                    ref.read(settingsNotifierProvider.notifier).setFederated(v);
                  },
                ),
                const SizedBox(height: 24),
                SizedBox(
                  height: 56,
                  child: FilledButton.icon(
                    focusNode: _saveFocus,
                    onPressed: () async {
                      await ref.read(settingsNotifierProvider.notifier).setApiBase(_urlCtrl.text);
                      if (context.mounted) {
                        ref.invalidate(videosProvider);
                        ref.invalidate(seriesProvider);
                        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Configuración guardada')));
                        Navigator.pop(context);
                      }
                    },
                    icon: const Icon(Icons.save),
                    label: const Text('GUARDAR Y CONECTAR', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  ),
                ),
                const SizedBox(height: 40),
                const Divider(color: Colors.white10),
                const SizedBox(height: 16),
                const Text('Tu identificador anónimo:', style: TextStyle(color: Colors.white38)),
                viewerAsync.when(
                  data: (k) => SelectableText(k, style: const TextStyle(fontFamily: 'monospace', color: Colors.white54)),
                  loading: () => const LinearProgressIndicator(),
                  error: (e, _) => Text('Error: $e'),
                ),
              ],
            ),
          ),
          
          // Right Side: Discovery Tools
          VerticalDivider(width: 1, color: Colors.white.withOpacity(0.1)),
          Expanded(
            flex: 2,
            child: Container(
              color: Colors.white.withOpacity(0.02),
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Autodescubrimiento', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  const Text('Busca servidores LANflix activos en tu red WiFi.', style: TextStyle(color: Colors.white54, fontSize: 13)),
                  const SizedBox(height: 20),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      focusNode: _discoverFocus,
                      onPressed: _isDiscovering ? null : _discover,
                      icon: _isDiscovering 
                          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.search),
                      label: Text(_isDiscovering ? 'BUSCANDO...' : 'BUSCAR NODOS'),
                    ),
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: TextButton.icon(
                      onPressed: _isDiscovering ? null : _deepScan,
                      icon: const Icon(Icons.auto_fix_high),
                      label: const Text('ESCANEO MÁGICO (SI FALLA EL OTRO)'),
                      style: TextButton.styleFrom(foregroundColor: Colors.amberAccent),
                    ),
                  ),
                  const SizedBox(height: 24),
                  if (_foundNodes.isEmpty && !_isDiscovering)
                    const Center(
                      child: Padding(
                        padding: EdgeInsets.only(top: 40),
                        child: Text('No hay nodos encontrados', style: TextStyle(color: Colors.white24)),
                      ),
                    ),
                  Expanded(
                    child: ListView.builder(
                      itemCount: _foundNodes.length,
                      itemBuilder: (context, index) {
                        final node = _foundNodes[index];
                        return Card(
                          margin: const EdgeInsets.only(bottom: 8),
                          child: ListTile(
                            leading: const Icon(Icons.dns, color: Colors.greenAccent),
                            title: Text(node),
                            subtitle: const Text('Servidor detectado'),
                            onTap: () {
                              _urlCtrl.text = node;
                              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Nodo seleccionado')));
                            },
                          ),
                        );
                      },
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _QuickCharButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback onTap;

  const _QuickCharButton({required this.label, this.icon, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      avatar: icon != null ? Icon(icon, size: 16) : null,
      label: Text(label),
      onPressed: onTap,
      backgroundColor: Colors.white.withOpacity(0.1),
    );
  }
}
