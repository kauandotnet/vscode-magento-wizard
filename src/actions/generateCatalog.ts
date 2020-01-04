import { workspace, WorkspaceFolder, tasks, ConfigurationTarget, ExtensionContext, TaskExecution, extensions, window, Uri } from 'vscode';
import * as convert from 'xml-js';
import magento from '../magento';
import { MagentoTaskProvider } from './MagentoTaskProvider';
import { fstat } from 'fs';


export default async function (context: ExtensionContext, workspaceFolder: WorkspaceFolder) {
    // const storageUri = Uri.parse(context.storagePath!);
    const storageUri = magento.appendUri(workspaceFolder.uri, '.vscode');
    const catalogOldUri = magento.appendUri(storageUri, 'catalog_tmp.xml');
    const catalogNewUri = magento.appendUri(storageUri, 'catalog.xml');

    let redhatXmlInstalled = !!extensions.getExtension('redhat.vscode-xml');
    const installXmlButton = 'Install XML extension';
    const existingFileButton = 'Use existing Magento XML Catalog file';
    let buttons = ['Generate XML Catalog', existingFileButton];
    if (!redhatXmlInstalled) {
        buttons.push(installXmlButton);
    }
    const response = await window.showInformationMessage(
        'This command will generate XML catalog' +
        ' with Magento 2 XML DTDs, which can be used for validation and completition in various XML configuration files.\n' +
        'Do you want to continue?',
        { modal: true },
        ...buttons
    );

    if (response === installXmlButton) {
        try {
            let { stdout, stderr } = await magento.exec('code --install-extension redhat.vscode-xml', {});
            console.log(stdout, stderr);
            window.showInformationMessage(stdout, { modal: true });
            redhatXmlInstalled = !!extensions.getExtension('redhat.vscode-xml');
        } catch {
            window.showInformationMessage('Error while installing Redhat XML extension, you can try to install it manually.', { modal: true });
        }
    } else if (!response) {
        return;
    }
    // Create .vscode folder if not exists in workspaceFolder
    await workspace.fs.createDirectory(storageUri);

    if (response === existingFileButton) {
        // use existing catalog file
        let selectedUri = await window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: workspaceFolder.uri,
            filters: {
                'Magento XML Catalog': ['xml'],
            },
            openLabel: 'Select XML Catalog'
        });
        if (selectedUri && selectedUri.length === 1) {
            convertCatalog(selectedUri[0]);
        }
        return;
    } else {
        // generate catalog file using bin/magento
        const taskProvider = new MagentoTaskProvider(workspaceFolder);
        const catalogTask = taskProvider.getTask('dev:urn-catalog:generate', [catalogOldUri.fsPath]);
        let taskExecution: TaskExecution;
        let token = tasks.onDidEndTask(async endTask => {
            if (endTask.execution === taskExecution) {
                token.dispose();
                if (!await magento.fileExists(catalogOldUri)) {
                    window.showErrorMessage('Catalog XML was not generated by bin/magento');
                    return;
                }
                convertCatalog(catalogOldUri);
            }
        });

        try {
            taskExecution = await tasks.executeTask(catalogTask);
        } catch (e) {
            console.error(e);
            throw new Error('Error executing ' + catalogTask.name);
        }
    }

    async function convertCatalog(catalogOldUri: Uri) {
        let xmlCatalog: any = {
            _declaration: { _attributes: { version: '1.0' } },
            catalog: {
                _attributes: { xmlns: 'urn:oasis:names:tc:entity:xmlns:xml:catalog' },
                system: [],
            }
        };
        if (!await magento.fileExists(catalogOldUri)) {
            window.showErrorMessage('Catalog XML file doesn\'t exists');
            return;
        }
        const catalogOldXml = await magento.readFile(catalogOldUri);
        try {
            var xml = convert.xml2js(catalogOldXml, {
                compact: true,
                alwaysChildren: true,
            }) as any;
        }
        catch (e) {
            console.error(e);
            throw new Error('Error parsing ' + catalogOldUri.fsPath);
        }
        if (xml && xml.project && xml.project.component) {
            for (let component of xml.project.component) {
                if (component.resource) {
                    for (let resource of component.resource) {
                        xmlCatalog.catalog.system.push({
                            _attributes: {
                                systemId: resource._attributes.url,
                                uri: resource._attributes.location,
                            }
                        });
                    }
                }
            }
        }

        const catalogXml = convert.js2xml(xmlCatalog, {
            spaces: 4,
            compact: true,
        });
        await magento.writeFile(catalogNewUri, catalogXml);
        await workspace.fs.delete(catalogOldUri);

        // adding catalog.xml to XML extension config
        const config = workspace.getConfiguration('', workspaceFolder.uri);
        let catalogs: string[] | undefined = config.get('xml.catalogs', []);
        if (catalogs && catalogs.length > 0) {
            // remove old value from the list
            catalogs = catalogs.filter(catalog => catalog !== catalogNewUri.fsPath);
        }
        else {
            catalogs = [];
        }
        catalogs.push(catalogNewUri.fsPath);
        if (redhatXmlInstalled) {
            await config.update('xml.catalogs', catalogs, ConfigurationTarget.Workspace);
            window.showInformationMessage(`Path to the generated XML catalog file (${catalogNewUri.fsPath}) was added to the XML extension configuration. Now you can enjoy Intellisense in Magento 2 XML configs.`, { modal: true });
        } else {
            window.showInformationMessage(`XML catalog file was generated (${catalogNewUri.fsPath}), you should install XML extension and add catalog file to it manually`, { modal: true });
        }
    }

}

