#!/usr/bin/env python3
"""
Unity RAG 社区检测脚本
使用 Louvain 算法对类依赖图聚类，发现隐含模块边界

用法: python3 detect_communities.py <xrefs_path> <output_path>
"""
import sys
import json

def main():
    if len(sys.argv) < 3:
        print("Usage: detect_communities.py <xrefs_path> <output_path>", file=sys.stderr)
        sys.exit(1)

    xrefs_path, output_path = sys.argv[1], sys.argv[2]

    try:
        import networkx as nx
    except ImportError:
        print("ERROR: networkx not installed. Run: pip3 install networkx", file=sys.stderr)
        sys.exit(1)

    # 读取 xrefs 数据
    try:
        with open(xrefs_path, encoding="utf-8") as f:
            xrefs = json.load(f)
    except Exception as e:
        print(f"ERROR: Cannot read xrefs: {e}", file=sys.stderr)
        sys.exit(1)

    # 构建无向图（继承+接口+字段类型依赖）
    G = nx.Graph()
    forward = xrefs.get("forward", {})
    for cls, entries in forward.items():
        G.add_node(cls)
        for e in entries:
            if e.get("type") in ("fieldType", "inheritance", "interface"):
                to_cls = e.get("toClass", "")
                if to_cls:
                    G.add_edge(cls, to_cls)

    if G.number_of_nodes() == 0:
        print("WARN: empty graph, no communities detected", file=sys.stderr)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump([], f)
        print("Communities: 0")
        return

    # 运行 Louvain 社区检测
    try:
        from networkx.algorithms import community as nx_comm
        communities_list = list(nx_comm.louvain_communities(G, seed=42))
    except AttributeError:
        # networkx < 2.7 fallback: 使用 greedy modularity
        try:
            from networkx.algorithms import community as nx_comm
            communities_list = list(nx_comm.greedy_modularity_communities(G))
        except Exception as e:
            print(f"ERROR: Community detection failed: {e}", file=sys.stderr)
            sys.exit(1)

    # 构建结果
    result = []
    for i, comm in enumerate(communities_list):
        classes = sorted(comm)
        result.append({
            "communityId": i,
            "classes": classes,
            "size": len(classes),
        })

    # 按大小降序排列
    result.sort(key=lambda c: c["size"], reverse=True)

    # 写入结果
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(f"Communities: {len(result)}")
    for c in result[:5]:
        sample = [n.split(".")[-1] for n in c["classes"][:3]]
        print(f"  [{c['communityId']}] size={c['size']}: {', '.join(sample)}...")

main()
