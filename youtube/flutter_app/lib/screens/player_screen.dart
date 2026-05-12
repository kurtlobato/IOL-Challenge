import 'dart:async';
import 'dart:convert';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:video_player/video_player.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../models/video_item.dart';
import '../providers/app_providers.dart';

class PlayerScreen extends ConsumerStatefulWidget {
  const PlayerScreen({super.key, required this.video});

  final VideoItem video;

  @override
  ConsumerState<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends ConsumerState<PlayerScreen> {
  VideoPlayerController? _controller;
  Timer? _viewTimer;
  Timer? _hideControlsTimer;
  int _lastReportedSeconds = 0;
  bool _showControls = true;
  double _volume = 1.0;
  int _selectedAudioTrack = 0;
  
  SubtitleItem? _currentSubtitle;
  final FocusNode _playPauseFocusNode = FocusNode();
  final FocusNode _audioFocusNode = FocusNode();
  final FocusNode _subtitleFocusNode = FocusNode();
  final FocusNode _backFocusNode = FocusNode();
  final FocusNode _restartFocusNode = FocusNode();
  final FocusScopeNode _focusScopeNode = FocusScopeNode();

  SharedPreferences? _prefs;
  Duration? _savedPosition;

  Future<void> _loadPrefs() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    _prefs = p;
    final savedVol = p.getDouble('lanflix_volume');
    if (savedVol != null) _volume = savedVol;
    final savedPos = p.getInt('lanflix_progress_${widget.video.id}');
    if (savedPos != null) {
      _savedPosition = Duration(seconds: savedPos);
    }
    final savedSub = p.getString('lanflix_subtitle_${widget.video.id}');
    if (savedSub != null && savedSub.isNotEmpty) {
      for (final s in widget.video.subtitles) {
        if (s.url == savedSub) {
          _currentSubtitle = s;
          break;
        }
      }
    }
  }

  @override
  void initState() {
    super.initState();
    _bootstrap();
    _startHideControlsTimer();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _playPauseFocusNode.requestFocus();
      }
    });
  }

  Future<void> _bootstrap() async {
    await _loadPrefs();
    if (!mounted) return;
    await _initController();
    
    final viewerKey = await ref.read(viewerKeyProvider.future);
    if (!mounted) return;
    _viewTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      unawaited(_reportView(viewerKey));
    });
  }
  Future<void> _initController() async {
    // Si se selecciona una pista de audio específica, usamos el stream directo
    // ya que el backend puede remapearlo al vuelo usando el parámetro audio_track.
    var uri = _selectedAudioTrack > 0 ? widget.video.streamUrl : widget.video.playbackUri;
    if (uri == null || uri.isEmpty) return;

    if (_selectedAudioTrack > 0) {
      final connector = uri.contains('?') ? '&' : '?';
      uri = '$uri${connector}audio_track=$_selectedAudioTrack';
    }

    Future<ClosedCaptionFile>? captionFile;
    if (_currentSubtitle != null) {
      captionFile = _loadSubtitle(_currentSubtitle!.url);
    }

    final oldController = _controller;
    final position = oldController?.value.position ?? Duration.zero;

    final c = VideoPlayerController.networkUrl(
      Uri.parse(uri),
      closedCaptionFile: captionFile,
    );
    
    _controller = c;
    try {
      await c.initialize();
      // Apply saved volume and position
      c.setVolume(_volume);
      if (_savedPosition != null) await c.seekTo(_savedPosition!);
      c.addListener(_onVideoUpdate);
      _volume = c.value.volume;
      await c.play();
      await WakelockPlus.enable();
    } catch (e) {
      debugPrint('Player error: $e');
    }

    if (oldController != null) {
      oldController.removeListener(_onVideoUpdate);
      Future.delayed(const Duration(milliseconds: 500), () => oldController.dispose());
    }
    
    if (mounted) {
      setState(() {});
      // Asegurar que el foco no se pierda al reconstruir
      _playPauseFocusNode.requestFocus();
    }
  }

  Future<ClosedCaptionFile> _loadSubtitle(String url) async {
    try {
      final response = await http.get(Uri.parse(url));
      if (response.statusCode == 200) {
        String content;
        try {
          content = utf8.decode(response.bodyBytes);
        } catch (_) {
          // Fallback para archivos con codificación antigua (latin1/iso-8859-1)
          content = latin1.decode(response.bodyBytes);
        }
        return _SrtCaptionFile(content);
      }
    } catch (e) {
      debugPrint('Error loading subtitle: $e');
    }
    return _EmptyCaptionFile();
  }

  void _onVideoUpdate() {
    // No need to persist on every frame; just trigger UI rebuild.
    if (mounted) setState(() {});
  }

  void _startHideControlsTimer() {
    _hideControlsTimer?.cancel();
    _hideControlsTimer = Timer(const Duration(seconds: 5), () {
      if (mounted && _controller != null && _controller!.value.isPlaying && _showControls) {
        setState(() {
          _showControls = false;
        });
      }
    });
  }

  void _showControlsTemporarily() {
    if (!_showControls) {
      setState(() {
        _showControls = true;
      });
    }
    // Solo forzar el foco inicial si el ámbito del reproductor no lo tiene
    // Esto evita que el foco "salte" si el usuario ya está navegando por otros botones
    if (!_focusScopeNode.hasFocus) {
      _playPauseFocusNode.requestFocus();
    }
    _startHideControlsTimer();
  }

  void _togglePlayPause() {
    final c = _controller;
    if (c == null) return;
    setState(() {
      if (c.value.isPlaying) {
        c.pause();
        // Persist position when pausing
        _prefs?.setInt('lanflix_progress_${widget.video.id}', c.value.position.inSeconds);
      } else {
        c.play();
      }
    });
    _showControlsTemporarily();
  }

  void _selectSubtitle(SubtitleItem? sub) {
    if (_currentSubtitle == sub) return;
    setState(() {
      _currentSubtitle = sub;
    });
    // Persist selected subtitle URL
    if (sub != null) {
      _prefs?.setString('lanflix_subtitle_${widget.video.id}', sub.url);
    } else {
      _prefs?.remove('lanflix_subtitle_${widget.video.id}');
    }
    _initController();
  }

  Future<void> _reportView(String viewerKey) async {
    final c = _controller;
    final api = ref.read(lanflixApiProvider);
    if (c == null || !c.value.isInitialized || api == null) return;
    final sec = c.value.position.inSeconds;
    if (sec <= _lastReportedSeconds) return;
    _lastReportedSeconds = sec;
    try {
      await api.recordViewForVideo(widget.video, viewerKey, sec);
    } catch (_) {}
  }

  @override
  void dispose() {
    // Save position before disposing
    if (_controller != null) {
      _prefs?.setInt('lanflix_progress_${widget.video.id}', _controller!.value.position.inSeconds);
    }
    _viewTimer?.cancel();
    _hideControlsTimer?.cancel();
    _playPauseFocusNode.dispose();
    _audioFocusNode.dispose();
    _subtitleFocusNode.dispose();
    _backFocusNode.dispose();
    _restartFocusNode.dispose();
    _focusScopeNode.dispose();
    WakelockPlus.disable();
    _controller?.removeListener(_onVideoUpdate);
    _controller?.dispose();
    super.dispose();
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, '0');
    final hours = duration.inHours;
    final minutes = twoDigits(duration.inMinutes.remainder(60));
    final seconds = twoDigits(duration.inSeconds.remainder(60));
    return hours > 0 ? "$hours:$minutes:$seconds" : "$minutes:$seconds";
  }

  void _showAudioMenu() {
    showDialog(
      context: context,
      barrierDismissible: true,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF1A1A1A),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('Pista de Audio', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: SizedBox(
          width: 350,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _SubtitleTile(
                  label: 'Por defecto',
                  isSelected: _selectedAudioTrack == 0,
                  onTap: () {
                    Navigator.pop(context);
                    if (_selectedAudioTrack != 0) {
                      setState(() => _selectedAudioTrack = 0);
                      _prefs?.remove('lanflix_audio_${widget.video.id}');
                      _initController();
                    }
                  },
                ),
                const Divider(color: Colors.white10),
                ...widget.video.audioTracks.map((t) => _SubtitleTile(
                  label: t.label,
                  isSelected: _selectedAudioTrack == t.index,
                  onTap: () {
                    Navigator.pop(context);
                    if (_selectedAudioTrack != t.index) {
                      setState(() => _selectedAudioTrack = t.index);
                      _prefs?.setInt('lanflix_audio_${widget.video.id}', t.index);
                      _initController();
                    }
                  },
                )),
              ],
            ),
          ),
        ),
      ),
    ).then((_) {
      _audioFocusNode.requestFocus();
    });
  }

  void _seekRelative(int seconds) {
    if (_controller == null) return;
    final target = _controller!.value.position + Duration(seconds: seconds);
    _controller!.seekTo(target);
    _showControlsTemporarily();
  }

  Future<void> _restartFromBeginning() async {
    final c = _controller;
    if (c == null || !c.value.isInitialized) return;
    _savedPosition = null;
    _prefs?.remove('lanflix_progress_${widget.video.id}');
    await c.seekTo(Duration.zero);
    await c.play();
    if (!mounted) return;
    setState(() {});
    _showControlsTemporarily();
  }

  void _showSubtitleMenu() {
    showDialog(
      context: context,
      barrierDismissible: true,
      builder: (context) => AlertDialog(
        backgroundColor: const Color(0xFF1A1A1A),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        title: const Text('Subtítulos', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        content: SizedBox(
          width: 350,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                _SubtitleTile(
                  label: 'Desactivados',
                  isSelected: _currentSubtitle == null,
                  onTap: () {
                    Navigator.pop(context);
                    _selectSubtitle(null);
                  },
                ),
                const Divider(color: Colors.white10),
                ...widget.video.subtitles.map((s) => _SubtitleTile(
                  label: s.label,
                  isSelected: _currentSubtitle == s,
                  onTap: () {
                    Navigator.pop(context);
                    _selectSubtitle(s);
                  },
                )),
              ],
            ),
          ),
        ),
      ),
    ).then((_) {
      _subtitleFocusNode.requestFocus();
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = _controller;
    final isInitialized = c != null && c.value.isInitialized;

    return Scaffold(
      backgroundColor: Colors.black,
      body: Shortcuts(
        shortcuts: <LogicalKeySet, Intent>{
          LogicalKeySet(LogicalKeyboardKey.select): const ActivateIntent(),
          LogicalKeySet(LogicalKeyboardKey.enter): const ActivateIntent(),
          LogicalKeySet(LogicalKeyboardKey.space): const ActivateIntent(),
        },
        child: FocusScope(
          node: _focusScopeNode,
          child: Focus(
            onKeyEvent: (node, event) {
              if (event is KeyDownEvent) {
                // Cualquier tecla del mando despierta los controles
                _showControlsTemporarily();
                
                if (event.logicalKey == LogicalKeyboardKey.escape ||
                    event.logicalKey == LogicalKeyboardKey.backspace) {
                  if (_showControls) {
                    setState(() => _showControls = false);
                    return KeyEventResult.handled;
                  }
                }
              }
              return KeyEventResult.ignored;
            },
            child: GestureDetector(
              onTap: _showControlsTemporarily,
              behavior: HitTestBehavior.opaque,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (isInitialized)
                    Center(
                      child: AspectRatio(
                        aspectRatio: c.value.aspectRatio == 0 ? 16 / 9 : c.value.aspectRatio,
                        child: VideoPlayer(c),
                      ),
                    )
                  else
                    const Center(child: CircularProgressIndicator(color: Colors.white24)),

                  // Subtitles Layer
                  if (isInitialized && _currentSubtitle != null && c.value.caption.text.isNotEmpty)
                    Positioned(
                      bottom: _showControls ? 160 : 60,
                      left: 100,
                      right: 100,
                      child: Text(
                        c.value.caption.text,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 34,
                          color: Colors.white,
                          height: 1.2,
                          fontWeight: FontWeight.bold,
                          shadows: [
                            Shadow(offset: Offset(-2, -2), color: Colors.black),
                            Shadow(offset: Offset(2, -2), color: Colors.black),
                            Shadow(offset: Offset(-2, 2), color: Colors.black),
                            Shadow(offset: Offset(2, 2), color: Colors.black),
                          ],
                        ),
                      ),
                    ),

                  // Controls Overlay
                  if (isInitialized)
                    AnimatedOpacity(
                      opacity: _showControls ? 1.0 : 0.0,
                      duration: const Duration(milliseconds: 300),
                      child: IgnorePointer(
                        ignoring: !_showControls,
                        child: Container(
                          decoration: BoxDecoration(
                            gradient: LinearGradient(
                              begin: Alignment.topCenter,
                              end: Alignment.bottomCenter,
                              colors: [
                                Colors.black.withOpacity(0.9),
                                Colors.transparent,
                                Colors.transparent,
                                Colors.black.withOpacity(0.9),
                              ],
                              stops: const [0.0, 0.25, 0.75, 1.0],
                            ),
                          ),
                          child: Stack(
                            children: [
                              // Top Bar
                              Positioned(
                                top: 0,
                                left: 0,
                                right: 0,
                                child: SafeArea(
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 32),
                                    child: Row(
                                      children: [
                                        _TopButton(
                                          focusNode: _backFocusNode,
                                          icon: Icons.arrow_back,
                                          onTap: () => Navigator.of(context).pop(),
                                        ),
                                        const SizedBox(width: 12),
                                        _TopButton(
                                          focusNode: _restartFocusNode,
                                          icon: Icons.restart_alt,
                                          onTap: () => unawaited(_restartFromBeginning()),
                                        ),
                                        const SizedBox(width: 24),
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                widget.video.title,
                                                style: const TextStyle(
                                                  color: Colors.white,
                                                  fontSize: 26,
                                                  fontWeight: FontWeight.bold,
                                                ),
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                              ),
                                              if (widget.video.nodeName != null)
                                                Text(
                                                  'Fuente: ${widget.video.nodeName!}',
                                                  style: TextStyle(
                                                    color: Colors.white.withOpacity(0.5),
                                                    fontSize: 16,
                                                  ),
                                                ),
                                            ],
                                          ),
                                        ),
                                        if (widget.video.audioTracks.isNotEmpty)
                                          _TopButton(
                                            focusNode: _audioFocusNode,
                                            icon: Icons.audiotrack,
                                            active: _selectedAudioTrack > 0,
                                            onTap: _showAudioMenu,
                                          ),
                                        if (widget.video.audioTracks.isNotEmpty)
                                          const SizedBox(width: 12),
                                        if (widget.video.subtitles.isNotEmpty)
                                          _TopButton(
                                            focusNode: _subtitleFocusNode,
                                            icon: _currentSubtitle != null 
                                                ? Icons.closed_caption 
                                                : Icons.closed_caption_disabled,
                                            active: _currentSubtitle != null,
                                            onTap: _showSubtitleMenu,
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),

                              // Center Controls
                              Center(
                                child: Row(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    _ControlButton(
                                      icon: Icons.replay_10,
                                      onTap: () => _seekRelative(-10),
                                    ),
                                    const SizedBox(width: 70),
                                    _ControlButton(
                                      focusNode: _playPauseFocusNode,
                                      icon: c.value.isPlaying ? Icons.pause : Icons.play_arrow,
                                      size: 96,
                                      isPrimary: true,
                                      onTap: _togglePlayPause,
                                    ),
                                    const SizedBox(width: 70),
                                    _ControlButton(
                                      icon: Icons.forward_10,
                                      onTap: () => _seekRelative(10),
                                    ),
                                  ],
                                ),
                              ),

                              // Bottom Bar
                              Positioned(
                                bottom: 0,
                                left: 0,
                                right: 0,
                                child: SafeArea(
                                  child: Padding(
                                    padding: const EdgeInsets.fromLTRB(64, 0, 64, 64),
                                    child: Column(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        SliderTheme(
                                          data: SliderTheme.of(context).copyWith(
                                            trackHeight: 8,
                                            thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 12),
                                            activeTrackColor: theme.colorScheme.primary,
                                            inactiveTrackColor: Colors.white24,
                                            thumbColor: theme.colorScheme.primary,
                                          ),
                                          child: Slider(
                                            value: c.value.position.inSeconds.toDouble(),
                                            max: c.value.duration.inSeconds.toDouble().clamp(1, double.infinity),
                                            onChanged: (val) {
                                              c.seekTo(Duration(seconds: val.toInt()));
                                              _showControlsTemporarily();
                                            },
                                          ),
                                        ),
                                        const SizedBox(height: 12),
                                        Padding(
                                          padding: const EdgeInsets.symmetric(horizontal: 16),
                                          child: Row(
                                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                            children: [
                                              Text(_formatDuration(c.value.position), 
                                                style: const TextStyle(color: Colors.white, fontSize: 20, fontFeatures: [FontFeature.tabularFigures()])),
                                              Text(_formatDuration(c.value.duration), 
                                                style: const TextStyle(color: Colors.white, fontSize: 20, fontFeatures: [FontFeature.tabularFigures()])),
                                            ],
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SubtitleTile extends StatelessWidget {
  final String label;
  final bool isSelected;
  final VoidCallback onTap;

  const _SubtitleTile({
    required this.label,
    required this.isSelected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      autofocus: isSelected, // Ayuda al mando a posicionarse en la opción actual
      title: Text(label, style: const TextStyle(color: Colors.white, fontSize: 20)),
      trailing: isSelected ? Icon(Icons.check_circle, color: Theme.of(context).colorScheme.primary) : null,
      onTap: onTap,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      hoverColor: Colors.white.withOpacity(0.1),
    );
  }
}

class _TopButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onTap;
  final bool active;
  final FocusNode? focusNode;

  const _TopButton({
    required this.icon,
    required this.onTap,
    this.active = false,
    this.focusNode,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        focusNode: focusNode,
        onTap: onTap,
        borderRadius: BorderRadius.circular(40),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.white.withOpacity(0.05),
          ),
          child: Icon(icon, color: active ? Theme.of(context).colorScheme.primary : Colors.white, size: 36),
        ),
      ),
    );
  }
}

class _ControlButton extends StatelessWidget {
  final IconData icon;
  final double size;
  final VoidCallback onTap;
  final bool isPrimary;
  final FocusNode? focusNode;

  const _ControlButton({
    required this.icon,
    this.size = 60,
    required this.onTap,
    this.isPrimary = false,
    this.focusNode,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        focusNode: focusNode,
        onTap: onTap,
        borderRadius: BorderRadius.circular(size),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: isPrimary ? Colors.white.withOpacity(0.15) : Colors.white.withOpacity(0.05),
            border: isPrimary ? Border.all(color: Colors.white24, width: 2) : null,
          ),
          child: Icon(icon, color: Colors.white, size: size),
        ),
      ),
    );
  }
}

class _SrtCaptionFile extends ClosedCaptionFile {
  _SrtCaptionFile(String content) : _captions = _parseSrt(content);
  final List<Caption> _captions;
  @override
  List<Caption> get captions => _captions;

  static List<Caption> _parseSrt(String content) {
    final List<Caption> captions = [];
    final normalized = content.replaceAll('\r\n', '\n').trim();
    final List<String> blocks = normalized.split(RegExp(r'\n\s*\n'));
    final timeRegex = RegExp(r'(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})');

    for (var block in blocks) {
      final lines = block.trim().split('\n');
      if (lines.length < 2) continue;
      int timeLineIndex = -1;
      for (int i = 0; i < lines.length; i++) {
        if (timeRegex.hasMatch(lines[i])) {
          timeLineIndex = i;
          break;
        }
      }
      if (timeLineIndex != -1 && timeLineIndex + 1 < lines.length) {
        final match = timeRegex.firstMatch(lines[timeLineIndex])!;
        final start = _parseSrtTime(match.group(1)!);
        final end = _parseSrtTime(match.group(2)!);
        var text = lines.sublist(timeLineIndex + 1).join('\n').trim();
        // Eliminar etiquetas HTML como <i></i> o <b></b>
        text = text.replaceAll(RegExp(r'<[^>]*>'), '');
        if (text.isNotEmpty) {
          captions.add(Caption(number: captions.length, start: start, end: end, text: text));
        }
      }
    }
    return captions;
  }

  static Duration _parseSrtTime(String s) {
    final parts = s.replaceAll(',', '.').split(':');
    final secondsParts = parts[2].split('.');
    return Duration(
      hours: int.parse(parts[0]),
      minutes: int.parse(parts[1]),
      seconds: int.parse(secondsParts[0]),
      milliseconds: int.parse(secondsParts[1]),
    );
  }
}

class _EmptyCaptionFile extends ClosedCaptionFile {
  @override
  List<Caption> get captions => const [];
}
