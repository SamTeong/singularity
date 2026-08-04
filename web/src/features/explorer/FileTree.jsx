import { getTokens } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import Typography from '@mui/material/Typography';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);
const isImage = (name) => IMG_EXTS.has((name.slice(name.lastIndexOf('.') + 1) || '').toLowerCase());

// One tree level: renders `path`'s already-fetched entries (childrenByPath.get(path))
// and recurses into expanded subfolders via Collapse. Never fetches on its own —
// onToggleDir (owned by ExplorerPanel) loads a folder's children on first expand.
export default function FileTree({ path, depth, expanded, childrenByPath, activePath, onToggleDir, onOpenFile, onContextMenu }) {
  const node = childrenByPath.get(path);
  if (!node) return null;
  // Separator matches what's already in this level's own path (Windows-safe).
  const sep = path.includes('/') && !path.includes('\\') ? '/' : '\\';
  const entries = node.entries;
  return (
    <>
      {entries.map((e) => {
        const childPath = path.endsWith(sep) ? path + e.name : path + sep + e.name;
        const isDir = e.type === 'dir';
        const open = isDir && expanded.has(childPath);
        return (
          <Box key={childPath}>
            <ListItemButton
              selected={!isDir && childPath === activePath}
              onClick={() => (isDir ? onToggleDir(childPath) : onOpenFile(childPath))}
              // stopPropagation: the rail's List has its own root-targeting handler.
              onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); onContextMenu(ev, { path: childPath, type: e.type, parentDir: path }); }}
              sx={{ pl: 2 + depth * 2, borderRadius: (t) => `${getTokens(t).radius.sm}px`, py: 0.25, mb: 0.25 }}
            >
              <ListItemIcon sx={{ minWidth: 20 }}>
                {isDir ? (open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />) : <Box sx={{ width: 16 }} />}
              </ListItemIcon>
              <ListItemIcon sx={{ minWidth: 22, color: 'text.secondary' }}>
                {isDir
                  ? (open ? <FolderOpenIcon fontSize="small" /> : <FolderIcon fontSize="small" />)
                  : (isImage(e.name) ? <ImageOutlinedIcon fontSize="small" /> : <InsertDriveFileOutlinedIcon fontSize="small" />)}
              </ListItemIcon>
              <Typography noWrap title={e.name} sx={{ fontSize: 13 }}>{e.name}</Typography>
            </ListItemButton>
            {isDir && (
              <Collapse in={open} timeout="auto" unmountOnExit>
                <FileTree path={childPath} depth={depth + 1} expanded={expanded} childrenByPath={childrenByPath}
                  activePath={activePath} onToggleDir={onToggleDir} onOpenFile={onOpenFile} onContextMenu={onContextMenu} />
              </Collapse>
            )}
          </Box>
        );
      })}
      {node.capped && <Typography sx={{ pl: 2 + depth * 2, py: 0.5, color: 'text.secondary', fontSize: 11 }}>(first 2000 entries)</Typography>}
    </>
  );
}
