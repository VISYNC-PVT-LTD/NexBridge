import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import '../../../../shared/widgets/app_button.dart';
import '../providers/leave_provider.dart';
import '../../data/sources/leave_remote_source.dart';

class LeaveApplyScreen extends ConsumerStatefulWidget {
  const LeaveApplyScreen({super.key});

  @override
  ConsumerState<LeaveApplyScreen> createState() => _LeaveApplyScreenState();
}

class _LeaveApplyScreenState extends ConsumerState<LeaveApplyScreen> {
  final _reasonCtrl = TextEditingController();
  // Codes must match the API enum (validators/leave.ts LEAVE_TYPES).
  String _leaveType = 'paidLeave';
  DateTime? _startDate;
  DateTime? _endDate;
  bool _loading = false;
  String? _error;

  static const _types = [
    ('paidLeave', 'Paid Leave'),
    ('sickLeave', 'Sick Leave'),
    ('casualLeave', 'Casual Leave'),
    ('lwp', 'Leave Without Pay'),
  ];

  int get _days {
    if (_startDate == null || _endDate == null) return 0;
    return _endDate!.difference(_startDate!).inDays + 1;
  }

  Future<void> _pickDate(bool isStart) async {
    final initial = isStart ? (_startDate ?? DateTime.now()) : (_endDate ?? _startDate ?? DateTime.now());
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime.now().subtract(const Duration(days: 7)),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (picked == null) return;
    setState(() {
      if (isStart) {
        _startDate = picked;
        if (_endDate != null && _endDate!.isBefore(picked)) _endDate = picked;
      } else {
        _endDate = picked;
      }
      _error = null; // a message about the field just changed is stale
    });
  }

  Future<void> _submit() async {
    if (_startDate == null || _endDate == null) { setState(() => _error = 'Select start and end dates.'); return; }
    if (_reasonCtrl.text.trim().isEmpty) { setState(() => _error = 'Reason is required.'); return; }

    setState(() { _loading = true; _error = null; });
    try {
      final fmt = DateFormat('yyyy-MM-dd');
      await ref.read(leaveSourceProvider).apply(
        leaveType: _leaveType,
        startDate: fmt.format(_startDate!),
        endDate: fmt.format(_endDate!),
        reason: _reasonCtrl.text.trim(),
      );
      ref.invalidate(leaveHistoryProvider);
      ref.invalidate(leaveBalanceProvider);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Leave request submitted.')));
      context.pop();
    } catch (e) {
      setState(() { _loading = false; _error = leaveSubmitErrorMessage(e); });
    }
  }

  @override
  void dispose() { _reasonCtrl.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    final fmt = DateFormat('dd MMM yyyy');
    return Scaffold(
      appBar: AppBar(title: const Text('Apply Leave')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_error != null) ...[
              Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: const Color(0xFFFEE2E2), borderRadius: BorderRadius.circular(8)), child: Text(_error!, style: const TextStyle(color: Color(0xFFB91C1C)))),
              const SizedBox(height: 12),
            ],

            const Text('Leave Type', style: TextStyle(fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            DropdownButtonFormField<String>(
              value: _leaveType,
              decoration: const InputDecoration(),
              items: _types.map((t) => DropdownMenuItem(value: t.$1, child: Text(t.$2))).toList(),
              onChanged: (v) => setState(() { _leaveType = v!; _error = null; }),
            ),
            const SizedBox(height: 16),

            Row(children: [
              Expanded(child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Start Date', style: TextStyle(fontWeight: FontWeight.w500)),
                  const SizedBox(height: 6),
                  InkWell(
                    onTap: () => _pickDate(true),
                    child: InputDecorator(decoration: const InputDecoration(), child: Text(_startDate != null ? fmt.format(_startDate!) : 'Select date', style: TextStyle(color: _startDate != null ? null : Colors.grey))),
                  ),
                ],
              )),
              const SizedBox(width: 12),
              Expanded(child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('End Date', style: TextStyle(fontWeight: FontWeight.w500)),
                  const SizedBox(height: 6),
                  InkWell(
                    onTap: () => _pickDate(false),
                    child: InputDecorator(decoration: const InputDecoration(), child: Text(_endDate != null ? fmt.format(_endDate!) : 'Select date', style: TextStyle(color: _endDate != null ? null : Colors.grey))),
                  ),
                ],
              )),
            ]),

            if (_days > 0) ...[
              const SizedBox(height: 8),
              Text('$_days day${_days != 1 ? 's' : ''}', style: const TextStyle(color: Color(0xFF2563EB), fontWeight: FontWeight.w500)),
            ],
            const SizedBox(height: 16),

            const Text('Reason', style: TextStyle(fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            TextFormField(
              controller: _reasonCtrl,
              maxLines: 3,
              decoration: const InputDecoration(hintText: 'Enter reason for leave...'),
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
