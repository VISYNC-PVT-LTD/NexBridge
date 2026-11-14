import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../../shared/widgets/app_button.dart';
import '../providers/regularization_provider.dart';

// Backend regularization types — must match validator/regularization.ts
const _types = [
  ('forgotCheckIn',       'Forgot Check-In'),
  ('forgotCheckOut',      'Forgot Check-Out'),
  ('workAwayFromOffice',  'Work Away From Office'),
  ('officialTravel',      'Official Travel'),
  ('clientVisit',         'Client Visit'),
];

// Types that require check-in time
const _needsCheckIn = {'forgotCheckIn', 'forgotCheckOut'};
// Types that require check-out time
const _needsCheckOut = {'forgotCheckIn', 'forgotCheckOut'};

class RegularizationCreateScreen extends ConsumerStatefulWidget {
  const RegularizationCreateScreen({super.key, this.initialDate, this.initialType, this.initialCheckIn});
  final String? initialDate;
  final String? initialType;
  final String? initialCheckIn;

  @override
  ConsumerState<RegularizationCreateScreen> createState() => _RegularizationCreateScreenState();
}

class _RegularizationCreateScreenState extends ConsumerState<RegularizationCreateScreen> {
  final _reasonCtrl = TextEditingController();
  late String _type;
  DateTime? _date;
  TimeOfDay? _checkIn;
  TimeOfDay? _checkOut;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // Pre-select type if provided (e.g. from forgot-checkout flow or work-away button)
    final validTypes = _types.map((t) => t.$1).toSet();
    _type = (widget.initialType != null && validTypes.contains(widget.initialType))
        ? widget.initialType!
        : _types.first.$1;

    if (widget.initialDate != null) {
      _date = DateTime.tryParse(widget.initialDate!);
    }

    if (widget.initialCheckIn != null) {
      final parts = widget.initialCheckIn!.split(':');
      if (parts.length == 2) {
        final h = int.tryParse(parts[0]);
        final m = int.tryParse(parts[1]);
        if (h != null && m != null) _checkIn = TimeOfDay(hour: h, minute: m);
      }
    }
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date ?? DateTime.now(),
      firstDate: DateTime.now().subtract(const Duration(days: 30)),
      lastDate: DateTime.now(),
    );
    // A validation message about a field the user has just changed is stale.
    if (picked != null) setState(() { _date = picked; _error = null; });
  }

  Future<void> _pickTime(bool isCheckIn) async {
    final initial = isCheckIn ? (_checkIn ?? TimeOfDay.now()) : (_checkOut ?? TimeOfDay.now());
    final picked = await showTimePicker(context: context, initialTime: initial);
    if (picked == null) return;
    setState(() {
      if (isCheckIn) { _checkIn = picked; } else { _checkOut = picked; }
      _error = null;
    });
  }

  // Backend requires full ISO 8601 datetime with offset (z.string().datetime({ offset: true })).
  // Convert date + TimeOfDay to UTC ISO string (e.g. "2026-07-04T12:25:00.000Z").
  String _toIsoDateTime(TimeOfDay t) {
    final local = DateTime(_date!.year, _date!.month, _date!.day, t.hour, t.minute);
    return local.toUtc().toIso8601String();
  }

  String _fmtTimeLabel(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  Future<void> _submit() async {
    if (_date == null) { setState(() => _error = 'Select a date.'); return; }
    if (_needsCheckIn.contains(_type) && _checkIn == null) { setState(() => _error = 'Check-in time is required for this type.'); return; }
    if (_needsCheckOut.contains(_type) && _checkOut == null) { setState(() => _error = 'Check-out time is required for this type.'); return; }
    final reason = _reasonCtrl.text.trim();
    if (reason.isEmpty) { setState(() => _error = 'Reason is required.'); return; }
    if (reason.length < 10) { setState(() => _error = 'Reason must be at least 10 characters.'); return; }

    setState(() { _loading = true; _error = null; });
    try {
      await ref.read(regularizationSourceProvider).create(
        date: DateFormat('yyyy-MM-dd').format(_date!),
        type: _type,
        reason: reason,
        requestedCheckIn: _needsCheckIn.contains(_type) && _checkIn != null ? _toIsoDateTime(_checkIn!) : null,
        requestedCheckOut: _needsCheckOut.contains(_type) && _checkOut != null ? _toIsoDateTime(_checkOut!) : null,
      );
      ref.invalidate(regularizationHistoryProvider);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Regularization request submitted.')));
      context.pop();
    } catch (e) {
      String msg = 'Submission failed. Please try again.';
      if (e is DioException) {
        final body = e.response?.data;
        if (body is Map<String, dynamic>) {
          final errMsg = body['error']?['message'] as String?;
          if (errMsg != null && errMsg.isNotEmpty) msg = errMsg;
        }
      }
      setState(() { _loading = false; _error = msg; });
    }
  }

  @override
  void dispose() { _reasonCtrl.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final fmt = DateFormat('dd MMM yyyy');
    final showTimePickers = _needsCheckIn.contains(_type) || _needsCheckOut.contains(_type);

    return Scaffold(
      appBar: AppBar(title: const Text('New Regularization')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_error != null) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: const Color(0xFFFEE2E2), borderRadius: BorderRadius.circular(8)),
                child: Text(_error!, style: const TextStyle(color: Color(0xFFB91C1C))),
              ),
              const SizedBox(height: 12),
            ],

            const Text('Date', style: TextStyle(fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            InkWell(
              onTap: _pickDate,
              child: InputDecorator(
                decoration: const InputDecoration(),
                child: Text(
                  _date != null ? fmt.format(_date!) : 'Select date',
                  style: TextStyle(color: _date != null ? null : Colors.grey),
                ),
              ),
            ),
            const SizedBox(height: 16),

            const Text('Type', style: TextStyle(fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            if (widget.initialType != null)
              InputDecorator(
                decoration: const InputDecoration(),
                child: Text(_types.firstWhere((t) => t.$1 == _type, orElse: () => (_type, _type)).$2),
              )
            else
              DropdownButtonFormField<String>(
                value: _type,
                decoration: const InputDecoration(),
                items: _types.map((t) => DropdownMenuItem(value: t.$1, child: Text(t.$2))).toList(),
                onChanged: (v) => setState(() {
                  _type = v!;
                  if (!_needsCheckIn.contains(_type)) _checkIn = null;
                  if (!_needsCheckOut.contains(_type)) _checkOut = null;
                  _error = null;
                }),
              ),
            const SizedBox(height: 16),

            if (showTimePickers) ...[
              Row(children: [
                if (_needsCheckIn.contains(_type))
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('Check-In Time', style: TextStyle(fontWeight: FontWeight.w500)),
                    const SizedBox(height: 6),
                    InkWell(
                      onTap: () => _pickTime(true),
                      child: InputDecorator(
                        decoration: const InputDecoration(),
                        child: Text(_checkIn != null ? _fmtTimeLabel(_checkIn!) : 'Select', style: TextStyle(color: _checkIn != null ? null : Colors.grey)),
                      ),
                    ),
                  ])),
                if (_needsCheckIn.contains(_type) && _needsCheckOut.contains(_type))
                  const SizedBox(width: 12),
                if (_needsCheckOut.contains(_type))
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text('Check-Out Time', style: TextStyle(fontWeight: FontWeight.w500)),
                    const SizedBox(height: 6),
                    InkWell(
                      onTap: () => _pickTime(false),
                      child: InputDecorator(
                        decoration: const InputDecoration(),
                        child: Text(_checkOut != null ? _fmtTimeLabel(_checkOut!) : 'Select', style: TextStyle(color: _checkOut != null ? null : Colors.grey)),
                      ),
                    ),
                  ])),
              ]),
              const SizedBox(height: 16),
            ],

            const Text('Reason', style: TextStyle(fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            TextFormField(
              controller: _reasonCtrl,
              maxLines: 3,
              decoration: const InputDecoration(hintText: 'Explain why you need regularization…'),
              onChanged: (_) { if (_error != null) setState(() => _error = null); },
            ),
            const SizedBox(height: 24),
            AppButton(label: 'Submit Request', onPressed: _submit, loading: _loading),
          ],
        ),
      ),
    );
  }
}
