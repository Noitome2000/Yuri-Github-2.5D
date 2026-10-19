[CmdletBinding()]
param([string]$ProjectRoot, [switch]$Cleanup, [switch]$Apply, [string]$RestoreBundle)
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding $false
if(!$ProjectRoot){$ProjectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../..'))}
$ProjectRoot=[IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\','/')
$rootPrefix=$ProjectRoot+'\'
function ProjectPath([string]$relative){
    if([IO.Path]::IsPathRooted($relative)-or $relative.Contains(':')){throw 'Absolute resource paths are not allowed.'}
    $full=[IO.Path]::GetFullPath((Join-Path $ProjectRoot $relative))
    if(!$full.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Path escapes project.'}
    $current=$full
    while($current -and $current.Length -ge $ProjectRoot.Length){
        if((Test-Path -LiteralPath $current)-and ((Get-Item -Force -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked resource paths are not supported.'}
        $current=[IO.Path]::GetDirectoryName($current)
    }
    return $full
}
function ReadJson([string]$path){return [IO.File]::ReadAllText($path,$utf8)|ConvertFrom-Json}
function WriteJson([string]$path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 100 -Compress),$utf8)}
function SetField($value,[string]$name,$data){$value|Add-Member -NotePropertyName $name -NotePropertyValue $data -Force}
function Digest([string]$path){return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function RecycledItem([string]$bundle){
    $shell=New-Object -ComObject Shell.Application;$name=[IO.Path]::GetFileName($bundle);$parent=[IO.Path]::GetDirectoryName($bundle)
    return @($shell.Namespace(10).Items())|Where-Object{$_.Name -eq $name -and $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq $parent}|Select-Object -First 1
}
function ModelPath([string]$relative){
    $path=ProjectPath $relative
    if(!$path.StartsWith((ProjectPath 'Graphics/MakerStudioPseudo3D/Models')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Path escapes managed model directory.'}
    return $path
}
function AssetFiles($asset){
    $files=@{};$source=([string]$asset.sourceObj).Replace('\','/')
    if(!$source.StartsWith('Graphics/MakerStudioPseudo3D/Models/',[StringComparison]::OrdinalIgnoreCase)){return $files}
    $obj=ModelPath $source
    if(![IO.File]::Exists($obj)){return $files}
    $files[$obj]=$true
    foreach($line in [IO.File]::ReadLines($obj)){
        if($line -notmatch '^\s*mtllib\s+(.+?)\s*$'){continue}
        $mtlRelative=[IO.Path]::GetDirectoryName($source)+'/'+$Matches[1].Trim('"')
        $mtl=ModelPath $mtlRelative
        if(![IO.File]::Exists($mtl)){throw "Missing or unsupported MTL reference: $mtlRelative"}
        $files[$mtl]=$true
        foreach($material in [IO.File]::ReadLines($mtl)){
            if($material -notmatch '^\s*(?:map_\w+|bump|disp|decal)\s+(.+?)\s*$'){continue}
            $texture=$Matches[1].Trim('"')
            if($texture.StartsWith('-')){throw 'MTL texture options require manual dependency review.'}
            $image=ModelPath ([IO.Path]::GetDirectoryName($mtlRelative)+'/'+$texture)
            if([IO.File]::Exists($image)){$files[$image]=$true}
        }
    }
    return $files
}
function BuildPlan($library,$request){
    $current=@{};foreach($asset in $library.assets){$current[[string]$asset.id]=$asset}
    $references=@{}
    foreach($file in Get-ChildItem -LiteralPath (ProjectPath 'Data/MakerStudioPseudo3D') -Filter 'Map*.json'){
        if($file.Name -notmatch '^Map\d+\.json$'){continue}
        foreach($instance in (ReadJson $file.FullName).instances){$references[[string]$instance.assetId]=$file.Name}
    }
    $removed=@{};$folders=@{}
    if($request.operation -eq 'cleanup'){
        foreach($file in Get-ChildItem -LiteralPath (ProjectPath 'Data/MakerStudioPseudo3D') -Filter 'library*.bak'|Sort-Object LastWriteTime){
            foreach($asset in (ReadJson $file.FullName).assets){if(!$current.ContainsKey([string]$asset.id)-and !$references.ContainsKey([string]$asset.id)){$removed[[string]$asset.id]=$asset}}
        }
    }elseif($request.operation -eq 'delete'){
        foreach($id in $request.ids){
            if(!$current.ContainsKey([string]$id)){throw "Resource no longer exists: $id"}
            if($references.ContainsKey([string]$id)){throw "Resource referenced by $($references[[string]$id]): $id"}
            $removed[[string]$id]=$current[[string]$id]
        }
        foreach($id in $request.folderIds){$folders[[string]$id]=$true}
        foreach($asset in $library.assets){if($folders.ContainsKey([string]$asset.folderId)-and !$removed.ContainsKey([string]$asset.id)){throw 'Folder contains a retained asset.'}}
        foreach($folder in $library.folders){if($folders.ContainsKey([string]$folder.parentId)-and !$folders.ContainsKey([string]$folder.id)){throw 'Folder contains a retained subfolder.'}}
    }else{throw 'Unknown operation.'}
    $remaining=@($library.assets|Where-Object{!$removed.ContainsKey([string]$_.id)})
    $protected=@{};foreach($asset in $remaining){foreach($file in (AssetFiles $asset).Keys){$protected[$file]=$true}}
    $candidates=@{};foreach($asset in $removed.Values){foreach($file in (AssetFiles $asset).Keys){if(!$protected.ContainsKey($file)){$candidates[$file]=$true}}}
    # Importers may emit extra material images unused by the final MTL. In a
    # dedicated model directory, recycle these too once no retained asset uses it.
    foreach($asset in $removed.Values){
        $relative=([string]$asset.sourceObj).Replace('\','/')
        if(!$relative.StartsWith('Graphics/MakerStudioPseudo3D/Models/',[StringComparison]::OrdinalIgnoreCase)){continue}
        $source=ModelPath $relative;$dir=[IO.Path]::GetDirectoryName($source);$stem=[IO.Path]::GetFileNameWithoutExtension($source)
        if(![IO.Directory]::Exists($dir)-or ($stem -ne [IO.Path]::GetFileName($dir)-and $stem -ne 'model')){continue}
        $relativeDir=$dir.Substring($rootPrefix.Length).Replace('\','/')+'/'
        if(@($remaining|Where-Object{([string]$_.sourceObj).Replace('\','/').StartsWith($relativeDir,[StringComparison]::OrdinalIgnoreCase)}).Count){continue}
        foreach($file in Get-ChildItem -LiteralPath $dir -File){
            if($file.Extension -notmatch '^\.(png|jpe?g)$'){continue}
            $path=ModelPath $file.FullName.Substring($rootPrefix.Length);if(!$protected.ContainsKey($path)){$candidates[$path]=$true}
        }
    }
    # Generated historical versions are reproducible from library data. Include
    # orphan OBJ/MTL/image outputs, without touching source import collections.
    $edited=ProjectPath 'Graphics/MakerStudioPseudo3D/Models/Edited'
    if(Test-Path -LiteralPath $edited){foreach($file in Get-ChildItem -LiteralPath $edited -Recurse -File){
        if($file.Extension -notmatch '^\.(obj|mtl|png|jpe?g)$'){continue}
        $path=ModelPath $file.FullName.Substring($rootPrefix.Length)
        if(!$protected.ContainsKey($path)){$candidates[$path]=$true}
    }}
    $used=@{};foreach($asset in $remaining){foreach($face in $asset.faces){if($face.texture){$used[[string]$face.texture]=$true}}}
    $removedTextures=@{};foreach($asset in $removed.Values){foreach($face in $asset.faces){if($face.texture){$removedTextures[[string]$face.texture]=$true}}}
    $unused=@($library.textures|Where-Object{$removedTextures.ContainsKey([string]$_.id)-and !$used.ContainsKey([string]$_.id)})
    return @{assets=@($removed.Values);remaining=$remaining;folderIds=$folders;folders=@($library.folders|Where-Object{$folders.ContainsKey([string]$_.id)});files=@($candidates.Keys|Sort-Object);unused=$unused}
}
function PruneEmptyParents([string[]]$files,[string]$limit){
    foreach($file in $files){$dir=[IO.Path]::GetDirectoryName($file)
        while($dir.StartsWith($limit+'\',[StringComparison]::OrdinalIgnoreCase)-and [IO.Directory]::Exists($dir)){
            if(@([IO.Directory]::EnumerateFileSystemEntries($dir)).Count){break}
            [IO.Directory]::Delete($dir);$dir=[IO.Path]::GetDirectoryName($dir)
        }
    }
}
function RemoveStaging([string]$relative){
    $bundle=ProjectPath $relative;$metadata=Join-Path $bundle 'resources.json'
    if([IO.File]::Exists($metadata)){[IO.File]::Delete($metadata)}
    foreach($dir in @(Get-ChildItem -LiteralPath $bundle -Directory -Recurse|Sort-Object {$_.FullName.Length} -Descending)){
        $checked=ProjectPath $dir.FullName.Substring($rootPrefix.Length)
        if(!@([IO.Directory]::EnumerateFileSystemEntries($checked)).Count){[IO.Directory]::Delete($checked)}
    }
    if(!@([IO.Directory]::EnumerateFileSystemEntries($bundle)).Count){[IO.Directory]::Delete($bundle)}
}
function RecycleBatch($request,[bool]$commit){
    $libPath=ProjectPath 'Data/MakerStudioPseudo3D/library.json';$before=[IO.File]::ReadAllText($libPath,$utf8);$hash=Digest $libPath
    if($request.expectedHash -and $request.expectedHash -ne $hash){throw 'Library changed; retry the operation.'}
    $library=$before|ConvertFrom-Json;$plan=BuildPlan $library $request
    $paths=@($plan.files|ForEach-Object{$_.Substring($rootPrefix.Length).Replace('\','/')});$bytes=0L;foreach($file in $plan.files){$bytes+=(Get-Item -LiteralPath $file).Length}
    $report=@{ok=$true;operation=$request.operation;assets=$plan.assets.Count;files=$paths.Count;bytes=$bytes;paths=$paths;unusedTextures=$plan.unused.Count}
    if(!$commit -or ($request.operation -eq 'cleanup'-and !$paths.Count -and !$plan.unused.Count)){return $report}
    $drive=New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($ProjectRoot));if($drive.DriveType -ne [IO.DriveType]::Fixed){throw 'Recycle requires a local fixed drive.'}
    $relative='Data/MakerStudioPseudo3D/.recycled/2.5D-resources-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
    $bundle=ProjectPath $relative;[IO.Directory]::CreateDirectory($bundle)|Out-Null
    $textureIds=@{};foreach($asset in $plan.assets){foreach($face in $asset.faces){if($face.texture){$textureIds[[string]$face.texture]=$true}}}
    $manifest=@{format='maker-studio-pseudo3d-recycled-v1';operation=$request.operation;assets=$plan.assets;folders=$plan.folders;textures=@($library.textures|Where-Object{$textureIds.ContainsKey([string]$_.id)});files=$paths}
    WriteJson (Join-Path $bundle 'resources.json') $manifest
    $moved=@();$written=$false
    try{
        if((Digest $libPath)-ne $hash){throw 'Library changed during preparation.'}
        for($i=0;$i -lt $paths.Count;$i++){
            $src=ModelPath $paths[$i];$dest=ProjectPath ($relative+'/files/'+$i+[IO.Path]::GetExtension($paths[$i]));[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))|Out-Null
            $fileHash=Digest $src;$moved+=@{source=$src;destination=$dest;hash=$fileHash}
            [IO.File]::Copy($src,$dest);if((Digest $dest)-ne $fileHash){throw 'Resource changed while preparing recycle.'}
        }
        if($request.operation -eq 'delete'-or $plan.unused.Count){
            SetField $library 'assets' $plan.remaining
            SetField $library 'folders' @($library.folders|Where-Object{!$plan.folderIds.ContainsKey([string]$_.id)})
            $unusedIds=@{};foreach($texture in $plan.unused){$unusedIds[[string]$texture.id]=$true}
            SetField $library 'textures' @($library.textures|Where-Object{!$unusedIds.ContainsKey([string]$_.id)})
            SetField $library 'revision' (1+[long]$library.revision)
            WriteJson $libPath $library;$written=$true
        }
        [RecycleResources]::Recycle($bundle)
        # Never remove the originals until the archived copy is demonstrably
        # present in the real Windows Recycle Bin (including long-path cases).
        if(!(RecycledItem $bundle)){throw 'Windows did not retain the archive in Recycle Bin; original files were kept.'}
        foreach($file in $moved){if((Digest $file.source)-ne $file.hash){throw 'A native resource changed during recycling.'};[IO.File]::Delete($file.source)}
    }catch{
        if($written){[IO.File]::WriteAllText($libPath,$before,$utf8)}
        if(![IO.Directory]::Exists($bundle)){$recycled=RecycledItem $bundle;if($recycled){[RecycleResources]::Restore($recycled.Path,[IO.Path]::GetDirectoryName($bundle),[IO.Path]::GetFileName($bundle))}}
        foreach($file in $moved){if([IO.File]::Exists($file.destination)){if(![IO.File]::Exists($file.source)){[IO.File]::Move($file.destination,$file.source)}else{[IO.File]::Delete($file.destination)}}}
        if([IO.Directory]::Exists($bundle)){RemoveStaging $relative}
        throw
    }
    # Nonessential empty-directory cleanup must not roll back a completed recycle.
    try{PruneEmptyParents $plan.files (ProjectPath 'Graphics/MakerStudioPseudo3D/Models')}catch{}
    $report.bundle=$relative;return $report
}
function RestoreBatch($request){
    $relative=[string]$request.bundle
    if($relative -notmatch '^Data/MakerStudioPseudo3D/\.recycled/2\.5D-resources-[\w-]+$'){throw 'Invalid recycle bundle.'}
    $bundle=ProjectPath $relative;$parent=[IO.Path]::GetDirectoryName($bundle);$name=[IO.Path]::GetFileName($bundle)
    $libPath=ProjectPath 'Data/MakerStudioPseudo3D/library.json';$before=[IO.File]::ReadAllText($libPath,$utf8)
    if($request.expectedHash -and $request.expectedHash -ne (Digest $libPath)){throw 'Library changed; retry restoration.'}
    if(![IO.Directory]::Exists($bundle)){
        $item=RecycledItem $bundle
        if(!$item){throw 'Resources are no longer in Windows Recycle Bin; undo remains available for retry.'}
        [IO.Directory]::CreateDirectory($parent)|Out-Null
        [RecycleResources]::Restore($item.Path,$parent,$name)
    }
    try{
    $archive=ReadJson (Join-Path $bundle 'resources.json');if($archive.format -ne 'maker-studio-pseudo3d-recycled-v1'){throw 'Invalid resource archive.'}
    $library=$before|ConvertFrom-Json;$ids=@{};foreach($asset in $library.assets){$ids[[string]$asset.id]=$true}
    foreach($asset in $archive.assets){if($archive.operation -ne 'cleanup'-and $ids.ContainsKey([string]$asset.id)){throw 'Resource ID already exists; no files overwritten.'}}
    $moves=@()
    for($i=0;$i -lt @($archive.files).Count;$i++){
        $file=$archive.files[$i];$dest=ModelPath $file;$src=ProjectPath ($relative+'/files/'+$i+[IO.Path]::GetExtension($file))
        if(!$src.StartsWith($bundle+'\files\',[StringComparison]::OrdinalIgnoreCase)-or ![IO.File]::Exists($src)-or (Test-Path -LiteralPath $dest)){throw "Restore file conflict: $file"}
        $moves+=@{source=$src;destination=$dest}
    }
    $moved=@()
    try{
        foreach($file in $moves){[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file.destination))|Out-Null;[IO.File]::Move($file.source,$file.destination);$moved+=$file}
        foreach($field in @('assets','folders','textures')){
            $known=@{};foreach($item in $library.$field){$known[[string]$item.id]=$true}
            SetField $library $field (@($library.$field)+@($archive.$field|Where-Object{!$known.ContainsKey([string]$_.id)}))
        }
        SetField $library 'revision' (1+[long]$library.revision);WriteJson $libPath $library
    }catch{
        [IO.File]::WriteAllText($libPath,$before,$utf8)
        foreach($file in $moved){if([IO.File]::Exists($file.destination)-and ![IO.File]::Exists($file.source)){[IO.File]::Move($file.destination,$file.source)}}
        throw
    }
    try{RemoveStaging $relative}catch{}
    return @{ok=$true;assets=@($archive.assets).Count;files=@($archive.files).Count}
    }catch{
        # A failed undo stays in the bin, with its history entry available for retry.
        if([IO.Directory]::Exists($bundle)){[RecycleResources]::Recycle($bundle)}
        throw
    }
}

[Reflection.Assembly]::LoadFrom((Join-Path $PSScriptRoot 'RecycleResources.exe'))|Out-Null
$lock=[IO.File]::Open((ProjectPath 'Data/MakerStudioPseudo3D/.recycle.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
    if($RestoreBundle){RestoreBatch ([pscustomobject]@{bundle=$RestoreBundle})|ConvertTo-Json -Depth 10}
    elseif($Cleanup){RecycleBatch ([pscustomobject]@{operation='cleanup'}) ([bool]$Apply)|ConvertTo-Json -Depth 10}
    else{
        $requests=ProjectPath 'Data/MakerStudioPseudo3D/.recycle-requests'
        if(Test-Path -LiteralPath $requests){foreach($file in Get-ChildItem -LiteralPath $requests -Filter 'request-*.json'|Sort-Object CreationTime){
            if($file.Name -notmatch '^request-([a-zA-Z0-9_-]+)\.json$'){continue}
            $response=ProjectPath ('Data/MakerStudioPseudo3D/.recycle-requests/result-'+$Matches[1]+'.json')
            if(Test-Path -LiteralPath $response){continue}
            try{
                $request=ReadJson (ProjectPath ('Data/MakerStudioPseudo3D/.recycle-requests/'+$file.Name))
                if(!$request.createdUtc-or ([DateTime]::UtcNow-[DateTime]::Parse($request.createdUtc).ToUniversalTime()).TotalSeconds -gt 120){throw 'Recycle request expired.'}
                if($request.operation -eq 'delete'){$result=RecycleBatch $request $true}
                elseif($request.operation -eq 'restore'){$result=RestoreBatch $request}else{throw 'Unsupported recycle request.'}
            }catch{$result=@{ok=$false;error=$_.Exception.Message}}
            WriteJson $response $result
        }}
    }
}finally{$lock.Dispose()}
