"""Make processes started by user code end with the kernel.

ML code starts worker processes all the time: scikit-learn ``n_jobs=-1``
(loky), PyTorch ``DataLoader(num_workers>0)``, ``multiprocessing``. When the
kernel exits normally (Stop, Restart, VS Code closing) the host's tree kill
finds no parent any more, and those workers kept running and holding memory.

* Windows: the kernel puts itself in a Job Object with
  ``KILL_ON_JOB_CLOSE``. Children inherit the job; when the kernel process
  ends for any reason (even a hard kill), the system closes the last job
  handle and ends every process still in it.
* POSIX: the host starts the kernel as a process-group leader; on exit the
  kernel kills its group. Only done when it really leads its own group, so
  a test runner that started it is never hit.
"""

from __future__ import annotations

import os
import signal
import sys

_job_handle: int | None = None


def contain_children() -> bool:
    """Called once at start-up. Returns True when containment is active."""
    if sys.platform == "win32":
        return _windows_job()
    try:
        return os.getpgid(0) == os.getpid()
    except OSError:
        return False


def exit_process(code: int) -> None:
    """Exit now, taking processes started by user code along."""
    if sys.platform != "win32":
        try:
            if os.getpgid(0) == os.getpid():
                # The whole group, the kernel included: this is the exit.
                os.killpg(os.getpid(), signal.SIGKILL)
        except OSError:
            pass
    # Windows: the job ends the children when this process is gone.
    os._exit(code)


def _windows_job() -> bool:
    global _job_handle
    if _job_handle is not None:
        return True
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:
        return False

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    job_object_extended_limit_information = 9
    kill_on_job_close = 0x2000
    # Programs that explicitly ask to outlive the kernel
    # (CREATE_BREAKAWAY_FROM_JOB) may still do so.
    breakaway_ok = 0x0800

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        return False
    info = ExtendedLimits()
    info.BasicLimitInformation.LimitFlags = kill_on_job_close | breakaway_ok
    ok = kernel32.SetInformationJobObject(job, job_object_extended_limit_information,
                                          ctypes.byref(info), ctypes.sizeof(info))
    # Nested jobs (Windows 8+) let this work even when VS Code runs in one.
    if not ok or not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
        kernel32.CloseHandle(job)
        return False
    # Never closed: the handle must live exactly as long as the process.
    _job_handle = job
    return True
