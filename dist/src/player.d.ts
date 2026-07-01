export declare class Player {
    private sessionData;
    load(filePath: string): Promise<void>;
    play(auto?: boolean): Promise<void>;
    private printEvent;
}
