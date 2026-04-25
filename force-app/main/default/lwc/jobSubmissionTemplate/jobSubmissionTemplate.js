import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { CloseActionScreenEvent } from 'lightning/actions'; // <-- ADD THIS LINE

// Apex methods
import getSubmissionTemplate from '@salesforce/apex/SubmissionTemplateController.getSubmissionTemplate';
import saveSubmissionTemplate from '@salesforce/apex/SubmissionTemplateController.saveSubmissionTemplate';
import getAllStageConfigs from '@salesforce/apex/SubmissionTemplateController.getAllStageConfigs'; 

export default class JobSubmissionTemplate extends LightningElement {
    
    // ─── MAGIC GETTER/SETTER: Waits for the Quick Action to pass the ID ───────
    _recordId;
    
    @api 
    get recordId() {
        return this._recordId;
    }
    set recordId(value) {
        if (value) {
            this._recordId = value;
            console.log('ID securely received from Salesforce:', this._recordId);
            this.loadData(); // Only load the data AFTER the ID is successfully captured!
        }
    }

    // Notice we COMPLETELY DELETED connectedCallback()!

    // ─── State Management ─────────────────────────────────────────────────────
    @track canvasData = [];  
    @track paletteData = []; 
    
    @track isModalOpen = false;
    @track isLoading = true;
    @track isSaving = false;
    @track isDirty = false;

    _originalCanvasData = [];
    _allConfigsMap = {}; 
    
    // Drag & Drop tracking
    _draggedKey = null;

    // ─── Data Loading ─────────────────────────────────────────────────────────

    async loadData() {
        this.isLoading = true;
        try {
            // Because of the setter above, this.recordId is guaranteed to exist now
            const [configs, savedStages] = await Promise.all([
                getAllStageConfigs(),
                getSubmissionTemplate({ jobId: this.recordId }) 
            ]);

            // 1. Build the Master Dictionary Map
            this._allConfigsMap = {};
            (configs || []).forEach(config => {
                this._allConfigsMap[config.stageKey] = config;
            });

            // 2. Build the Initial Canvas
            let loadedCanvas = [];
            let savedKeys = new Set();

            (savedStages || []).forEach(saved => {
                const config = this._allConfigsMap[saved.stageKey];
                if (config && saved.isActive) {
                    savedKeys.add(saved.stageKey);
                    const isLocked = config.isDefaultRequired;
                    
                    loadedCanvas.push({
                        key: saved.stageKey,
                        label: config.label,
                        iconName: config.iconName,
                        index: saved.stageIndex,
                        isRequired: isLocked ? true : saved.isRequired,
                        isLocked: isLocked
                    });
                }
            });

            // 3. Enforce Mandatory Defaults
            Object.values(this._allConfigsMap).forEach(config => {
                if (config.isDefaultRequired && !savedKeys.has(config.stageKey)) {
                    loadedCanvas.push({
                        key: config.stageKey,
                        label: config.label,
                        iconName: config.iconName,
                        index: 999, 
                        isRequired: true,
                        isLocked: true
                    });
                }
            });

            loadedCanvas.sort((a, b) => a.index - b.index);
            this.canvasData = loadedCanvas;
            this.reindexCanvas();

            this._originalCanvasData = JSON.stringify(this.canvasData);
            this.isDirty = false;

        } catch (error) {
            this.showToast('Error', this.getErrorMessage(error), 'error');
        } finally {
            this.isLoading = false;
        }
    }

    // ─── Getters for HTML ─────────────────────────────────────────────────────
    
    get isCanvasEmpty() { return this.canvasData.length === 0; }
    get paletteStages() { return this.paletteData; }
    get totalCount()    { return this.canvasData.length; }
    get requiredCount() { return this.canvasData.filter(s => s.isRequired).length; }

    get canvasStages() {
        const total = this.canvasData.length;
        return this.canvasData.map((s, i) => {
            return {
                ...s,
                isFirst: i === 0,
                isLast: i === total - 1,
                rowClass: 'st-stage-row st-stage-row--active',
                requiredToggleClass: s.isRequired ? 'st-toggle st-toggle--on' : 'st-toggle',
                requiredLabel: s.isRequired ? 'Yes' : 'No',
                isRequiredStr: String(s.isRequired)
            };
        });
    }

    // ─── Drag and Drop Logic ──────────────────────────────────────────────────
    
    handleDragStart(event) {
        this._draggedKey = event.currentTarget.dataset.key;
        event.dataTransfer.effectAllowed = 'move';
        event.currentTarget.classList.add('st-row-dragging');
    }

    handleDragOver(event) {
        event.preventDefault(); 
        event.dataTransfer.dropEffect = 'move';
        const currentTarget = event.currentTarget;
        if (currentTarget.dataset.key !== this._draggedKey) {
            currentTarget.classList.add('st-row-drag-over');
        }
    }

    handleDragLeave(event) {
        event.currentTarget.classList.remove('st-row-drag-over');
    }

    handleDrop(event) {
        event.preventDefault();
        event.currentTarget.classList.remove('st-row-drag-over');
        
        const droppedKey = event.currentTarget.dataset.key;

        if (this._draggedKey && this._draggedKey !== droppedKey) {
            const draggedIdx = this.canvasData.findIndex(s => s.key === this._draggedKey);
            const droppedIdx = this.canvasData.findIndex(s => s.key === droppedKey);

            if (draggedIdx > -1 && droppedIdx > -1) {
                const newData = [...this.canvasData];
                const [draggedItem] = newData.splice(draggedIdx, 1);
                newData.splice(droppedIdx, 0, draggedItem);

                this.canvasData = newData;
                this.reindexCanvas();
                this.markDirty();
            }
        }
        
        this.cleanupDragStyles();
        this._draggedKey = null;
    }

    handleDragOverContainer(event) {
        event.preventDefault(); 
    }

    cleanupDragStyles() {
        const rows = this.template.querySelectorAll('.st-stage-row');
        rows.forEach(row => {
            row.classList.remove('st-row-dragging');
            row.classList.remove('st-row-drag-over');
        });
    }

    // ─── Modal & Palette Logic ────────────────────────────────────────────────
    
    openSettingsModal() {
        const canvasKeys = new Set(this.canvasData.map(s => s.key));
        
        this.paletteData = Object.values(this._allConfigsMap).map(config => {
            const isLocked = config.isDefaultRequired;
            const isSelected = isLocked || canvasKeys.has(config.stageKey);
            
            return {
                key: config.stageKey,
                label: config.label,
                iconName: config.iconName,
                isSelected: isSelected,
                isLocked: isLocked, 
                itemClass: isLocked ? 'st-palette-item st-palette-item--locked' : 'st-palette-item'
            };
        });

        this.isModalOpen = true;
    }

    closeSettingsModal() {
        this.isModalOpen = false;
    }

    handlePaletteSelection(event) {
        const key = event.currentTarget.dataset.key;
        const isChecked = event.target.checked;
        
        this.paletteData = this.paletteData.map(item => {
            if (item.key === key && !item.isLocked) { 
                return { ...item, isSelected: isChecked };
            }
            return item;
        });
    }

    applySettings() {
        let newCanvas = [...this.canvasData];

        this.paletteData.forEach(item => {
            const existsOnCanvas = newCanvas.find(s => s.key === item.key);
            
            if (item.isSelected && !existsOnCanvas) {
                const config = this._allConfigsMap[item.key];
                newCanvas.push({
                    key: config.stageKey,
                    label: config.label,
                    iconName: config.iconName,
                    isRequired: config.isDefaultRequired || false,
                    isLocked: config.isDefaultRequired
                });
            } 
            else if (!item.isSelected && existsOnCanvas && !existsOnCanvas.isLocked) {
                newCanvas = newCanvas.filter(s => s.key !== item.key);
            }
        });

        this.canvasData = newCanvas;
        this.reindexCanvas();
        this.markDirty();
        this.closeSettingsModal();
    }

    // ─── Canvas Grid Actions ──────────────────────────────────────────────────
    
    handleRemoveFromCanvas(event) {
        const key = event.currentTarget.dataset.key;
        const stage = this.canvasData.find(s => s.key === key);
        if (stage && stage.isLocked) return;

        this.canvasData = this.canvasData.filter(s => s.key !== key);
        this.reindexCanvas();
        this.markDirty();
    }

    handleToggleRequired(event) {
        const key = event.currentTarget.dataset.key;
        this.canvasData = this.canvasData.map(s => {
            if (s.key === key && !s.isLocked) {
                return { ...s, isRequired: !s.isRequired };
            }
            return s;
        });
        this.markDirty();
    }

    // ─── Save & Reset ─────────────────────────────────────────────────────────
    
    handleReset() {
        this.canvasData = JSON.parse(this._originalCanvasData);
        this.isDirty = false;
    }

    async handleSave() {
        this.isSaving = true;
        try {
            const payload = this.canvasData.map(s => ({
                stageKey: s.key,
                stageIndex: s.index,
                isRequired: s.isRequired,
                isActive: true 
            }));

            await saveSubmissionTemplate({
                jobId: this.recordId,
                stagesJson: JSON.stringify(payload)
            });

            this._originalCanvasData = JSON.stringify(this.canvasData);
            this.isDirty = false;
            this.showToast('Success', 'Submission template saved successfully.', 'success');
            
            // <-- ADD THIS LINE to automatically close the popup window!
            this.dispatchEvent(new CloseActionScreenEvent()); 

        } catch (error) {
            this.showToast('Error', this.getErrorMessage(error), 'error');
        } finally {
            this.isSaving = false;
        }
    }

    // ─── Utilities ────────────────────────────────────────────────────────────
    
    reindexCanvas() {
        this.canvasData = this.canvasData.map((s, i) => ({ ...s, index: i + 1 }));
    }

    markDirty() {
        this.isDirty = JSON.stringify(this.canvasData) !== this._originalCanvasData;
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    getErrorMessage(error) {
        if (Array.isArray(error?.body)) return error.body.map(e => e.message).join(', ');
        if (typeof error?.body?.message === 'string') return error.body.message;
        if (typeof error?.message === 'string') return error.message;
        return 'Unknown error';
    }
}