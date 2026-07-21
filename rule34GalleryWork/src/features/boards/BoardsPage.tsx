import {useEffect,useState} from "react";
import {Archive,ArchiveRestore,Copy,Plus} from "lucide-react";
import {useNavigate} from "react-router-dom";
import {BOARDS_CHANGED,createBoard,duplicateBoard,loadBoards,setBoardArchived} from "@/services/boardService";
import type {BoardRecord} from "@/types/board";
export default function BoardsPage(){
 const nav=useNavigate(); const [boards,setBoards]=useState<BoardRecord[]>(()=>loadBoards()); const [showArchived,setShowArchived]=useState(false);
 useEffect(()=>{const refresh=()=>setBoards(loadBoards());window.addEventListener(BOARDS_CHANGED,refresh);return()=>window.removeEventListener(BOARDS_CHANGED,refresh);},[]);
 function make(){const name=prompt("Board name");if(name?.trim()){const b=createBoard(name);nav(`/boards/${b.id}`);}}
 const shown=boards.filter(b=>showArchived||!b.archived);
 return <div className="boardsPage"><div className="boardsHeader"><div><h1>Boards</h1><p>{shown.length} board{shown.length===1?"":"s"}</p></div><div><button onClick={()=>setShowArchived(v=>!v)}>{showArchived?<ArchiveRestore size={16}/>:<Archive size={16}/>} {showArchived?"Hide archived":"Show archived"}</button><button className="primary" onClick={make}><Plus size={16}/> New board</button></div></div><div className="boardsGrid">{shown.map(b=><article className="boardCard" key={b.id}><button className="boardOpen" onClick={()=>nav(`/boards/${b.id}`)}><strong>{b.name}</strong><span>{b.items.length} item{b.items.length===1?"":"s"}</span><small>Updated {new Date(b.updatedAt).toLocaleString()}</small></button><div className="boardCardActions"><button onClick={()=>duplicateBoard(b.id)}><Copy size={15}/> Duplicate</button><button onClick={()=>setBoardArchived(b.id,!b.archived)}>{b.archived?<ArchiveRestore size={15}/>:<Archive size={15}/>} {b.archived?"Restore":"Archive"}</button></div></article>)}</div>{shown.length===0&&<div className="state">No boards yet.</div>}</div>;
}
