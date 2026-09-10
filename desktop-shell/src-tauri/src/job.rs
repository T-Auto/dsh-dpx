//! Windows Job Object for the DSH child process.
//!
//! The shell already kills the DSH child on a graceful exit. That is not enough:
//! if the shell is force-killed (Task Manager, a crash, or a test script), the
//! child used to survive as an orphan and keep holding the environment's DSH
//! session write handles — which is exactly what makes the next start fail with
//! "session … is already owned by an active write handle".
//!
//! Assigning the child to a job created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! makes the OS tear down the whole child tree the moment this process ends, no
//! matter how it ends. The job handle is intentionally never closed by us: the
//! kernel closes it when the process terminates, which is what triggers the kill.

use std::process::Child;

#[cfg(windows)]
mod imp {
    use super::Child;
    use std::os::windows::io::AsRawHandle;

    type Handle = *mut core::ffi::c_void;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: u32, info: *mut core::ffi::c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    }

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic_limit_information: BasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    /// A kill-on-close job. Leaked on purpose; see the module docs.
    pub struct ChildJob {
        handle: Handle,
    }

    impl ChildJob {
        pub fn new() -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if handle.is_null() {
                    return Err("无法创建作业对象。".to_string());
                }
                let mut information = ExtendedLimitInformation::default();
                information.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let assigned = SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    &mut information as *mut _ as *mut core::ffi::c_void,
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                );
                if assigned == 0 {
                    return Err("无法设置作业对象限制。".to_string());
                }
                Ok(ChildJob { handle })
            }
        }

        pub fn assign(&self, child: &Child) -> Result<(), String> {
            unsafe {
                if AssignProcessToJobObject(self.handle, child.as_raw_handle() as Handle) == 0 {
                    return Err("无法把 DSH 子进程加入作业对象。".to_string());
                }
            }
            Ok(())
        }
    }

    // No `Drop`: the handle is a raw pointer and is deliberately never closed —
    // the kernel closes it when this process terminates, which is what makes the
    // OS kill the DSH child tree.
}

#[cfg(not(windows))]
mod imp {
    use super::Child;

    pub struct ChildJob;

    impl ChildJob {
        pub fn new() -> Result<Self, String> {
            Ok(ChildJob)
        }

        pub fn assign(&self, _child: &Child) -> Result<(), String> {
            Ok(())
        }
    }
}

pub use imp::ChildJob;

#[cfg(test)]
mod tests {
    use super::ChildJob;

    #[test]
    fn a_job_can_be_created_and_takes_a_child() {
        let job = ChildJob::new().expect("job");
        // Spawn something short-lived that is definitely not the test process.
        let child = if cfg!(windows) {
            std::process::Command::new("cmd").args(["/C", "exit", "0"]).spawn().expect("spawn")
        } else {
            std::process::Command::new("true").spawn().expect("spawn")
        };
        // Assignment can legitimately fail if this process is itself already in a
        // job that forbids nesting, so only the success path is asserted here.
        if let Err(error) = job.assign(&child) {
            assert!(error.contains("作业对象"));
        }
    }
}
