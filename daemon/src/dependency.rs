use std::collections::{HashMap, HashSet};
use sysinfo::{System, Pid};

pub struct DependencyMap {
    /// parent_pid -> set of child pids
    pub children: HashMap<u32, HashSet<u32>>,
    /// child_pid -> parent_pid
    pub parents: HashMap<u32, u32>,
}

impl DependencyMap {
    pub fn build(sys: &System) -> Self {
        let mut children: HashMap<u32, HashSet<u32>> = HashMap::new();
        let mut parents: HashMap<u32, u32> = HashMap::new();

        for (pid, process) in sys.processes() {
            if let Some(parent_pid) = process.parent() {
                let parent_u32 = parent_pid.as_u32();
                let child_u32 = pid.as_u32();
                children
                    .entry(parent_u32)
                    .or_insert_with(HashSet::new)
                    .insert(child_u32);
                parents.insert(child_u32, parent_u32);
            }
        }

        DependencyMap { children, parents }
    }

    /// True if any direct child of `pid` is actively using CPU (>0.5%).
    pub fn has_active_children(&self, pid: u32, sys: &System) -> bool {
        if let Some(child_pids) = self.children.get(&pid) {
            for &child_pid in child_pids {
                if let Some(process) = sys.process(Pid::from_u32(child_pid)) {
                    if process.cpu_usage() > 0.5 {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// True if the direct parent of `pid` is classified as Protected.
    pub fn has_protected_parent(&self, pid: u32, sys: &System) -> bool {
        if let Some(&parent_pid) = self.parents.get(&pid) {
            if let Some(process) = sys.process(Pid::from_u32(parent_pid)) {
                let name = process.name().to_string();
                return crate::classifier::classify(&name)
                    == crate::classifier::Classification::Protected;
            }
        }
        false
    }

    /// All descendants of `pid` collected recursively (depth-first).
    pub fn get_all_descendants(&self, pid: u32) -> HashSet<u32> {
        let mut descendants = HashSet::new();
        let mut to_visit = vec![pid];

        while let Some(current) = to_visit.pop() {
            if let Some(child_pids) = self.children.get(&current) {
                for &child in child_pids {
                    if descendants.insert(child) {
                        to_visit.push(child);
                    }
                }
            }
        }
        descendants
    }

    /// Returns false when suspending `pid` would violate a dependency constraint,
    /// logging the specific reason via eprintln.
    pub fn is_safe_to_suspend(&self, pid: u32, name: &str, sys: &System) -> bool {
        if self.has_active_children(pid, sys) {
            eprintln!("[dep-check] PID {} ({}) — suspension blocked: active children", pid, name);
            return false;
        }
        if self.has_protected_parent(pid, sys) {
            eprintln!("[dep-check] PID {} ({}) — suspension blocked: protected parent", pid, name);
            return false;
        }
        true
    }
}
